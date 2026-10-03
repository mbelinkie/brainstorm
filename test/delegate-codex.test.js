import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExecArgs, childEnv, parseEvents, parseDecision, overBudget, creditsFor, parseRateLimits, headroom } from "../tools/delegate/core/codex.mjs";
import { runCodexSession } from "../tools/delegate/codex-session.mjs";
import { spawn as realSpawn } from "node:child_process";

test("exec args: model, effort, sandbox, cwd, output file and stdin prompt; resume uses the thread id", () => {
  const args = buildExecArgs({ model: "gpt-6-luna", effort: "high", cwd: "/w", outputFile: "/o.txt", extraConfig: ["sandbox_workspace_write.network_access=true"] });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "-m", "gpt-6-luna"]);
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", "/w"]);
  assert.equal(args.at(-1), "-");
  const resume = buildExecArgs({ model: "gpt-6-luna", effort: "high", outputFile: "/o.txt", resumeId: "019a-thread" });
  assert.deepEqual(resume.slice(0, 3), ["exec", "resume", "--json"]);
  assert.ok(!resume.includes("-C") && !resume.includes("-s"), "resume takes neither -C nor -s");
  assert.deepEqual(resume.slice(-2), ["019a-thread", "-"]);
});

test("launched sessions never inherit an execution identity", () => {
  const env = childEnv({ PATH: "/bin", CODEX_THREAD_ID: "parent", CODEX_SESSION_ID: "p", CLAUDE_CODE_SESSION_ID: "c", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("launched sessions get GH_TOKEN only from the harness's token file, never the parent shell", () => {
  assert.equal(childEnv({ PATH: "/bin", GH_TOKEN: "from-shell", GITHUB_TOKEN: "also-shell" }).GH_TOKEN, undefined);
  assert.equal(childEnv({ PATH: "/bin", GITHUB_TOKEN: "also-shell" }).GITHUB_TOKEN, undefined);
  const env = childEnv({ PATH: "/bin", GH_TOKEN: "from-shell" }, { githubToken: "from-file" });
  assert.deepEqual(env, { PATH: "/bin", GH_TOKEN: "from-file" });
});

test("events: thread id, summed usage across turns, failures", () => {
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "019a-abc" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }),
    "not json",
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 70 } }),
  ].join("\n");
  const e = parseEvents(jsonl);
  assert.equal(e.threadId, "019a-abc");
  assert.deepEqual(e.usage, { input: 3000, cached: 1900, output: 120 });
  assert.equal(e.turns, 2);
  assert.equal(e.unparsed, 1);
  assert.equal(parseEvents(JSON.stringify({ type: "turn.failed", error: { message: "usage limit" } })).failed, true);
  assert.equal(parseEvents("").usage, null, "no usage is null, never zero");
});

test("events: the real shape of a rejected session (codex-cli on Matthew's Mac, 2026-10-02)", () => {
  const msg = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account." } });
  const e = parseEvents([
    JSON.stringify({ type: "thread.started", thread_id: "01a0ffa2-7ebc-7351-80b4-ae3a47b67511" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "warning" } }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "error", message: msg }),
    JSON.stringify({ type: "turn.failed", error: { message: msg } }),
  ].join("\n"));
  assert.equal(e.threadId, "01a0ffa2-7ebc-7351-80b4-ae3a47b67511");
  assert.equal(e.failed, true);
  assert.equal(e.usage, null);
  assert.equal(e.errors.at(-1), "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.", "the provider's message, unwrapped");
});

test("decisions: last fenced JSON object wins; prose or arrays are refused", () => {
  assert.deepEqual(parseDecision('thinking...\n```json\n{"decision":"REPAIR"}\n```\nmore\n```json\n{"decision":"ACCEPT"}\n```').value, { decision: "ACCEPT" });
  assert.deepEqual(parseDecision('{"verified":true}').value, { verified: true });
  assert.equal(parseDecision("I accept").code, "DECISION_UNPARSEABLE");
  assert.equal(parseDecision("[1]").code, "DECISION_SHAPE");
});

test("budgets and credits", () => {
  assert.equal(overBudget(null, { input: 1, output: 1 }).over, true);
  assert.equal(overBudget({ input: 10, cached: 0, output: 1 }, { input: 9, output: 5 }).over, true);
  assert.equal(overBudget({ input: 10, cached: 0, output: 6 }, { input: 10, output: 5 }).over, true);
  assert.equal(overBudget({ input: 10, cached: 0, output: 5 }, { input: 10, output: 5 }).over, false);
  // 1M uncached + 1M cached + 1M output on Luna = 2.5 + 0.25 + 12.5
  assert.equal(creditsFor("gpt-6-luna", { input: 2_000_000, cached: 1_000_000, output: 1_000_000 }), 15.25);
  assert.equal(creditsFor("unknown", { input: 1, cached: 0, output: 1 }), null);
});

test("rate limits: latest snapshot from a session log; headroom decisions", () => {
  const log = [
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1790000000 } } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 85, window_minutes: 300, resets_at: 1790000000 }, secondary: { used_percent: 40, window_minutes: 10080 } } } }),
  ].join("\n");
  const reading = parseRateLimits(log);
  assert.equal(reading.primary.usedPercent, 85);
  assert.equal(reading.secondary.usedPercent, 40);
  assert.equal(parseRateLimits("{}"), null);

  assert.equal(headroom({ reading: null, headroomPercent: 80, firstSession: true }).action, "start");
  assert.equal(headroom({ reading: null, headroomPercent: 80 }).code, "USAGE_UNKNOWN");
  assert.equal(headroom({ reading: null, headroomPercent: 80, requireReading: false }).action, "start");
  const wait = headroom({ reading, headroomPercent: 80, nowMs: 0 });
  assert.equal(wait.action, "wait");
  assert.equal(wait.untilMs, 1790000000 * 1000);
  assert.equal(headroom({ reading, headroomPercent: 80, creditCap: 50, creditsSpent: 10 }).onCredits, true);
  assert.equal(headroom({ reading: { primary: { usedPercent: 10 }, secondary: { usedPercent: 100 } }, headroomPercent: 80 }).code, "WEEKLY_LIMIT");
  assert.equal(headroom({ reading: { primary: { usedPercent: 90, resetsAt: null } }, headroomPercent: 80 }).code, "RESET_UNKNOWN");
  assert.equal(headroom({ reading: { primary: { usedPercent: 50 } }, headroomPercent: 80 }).action, "start");
});

// A fake `codex` binary: records its argv and env, prints JSONL events and
// writes the last message to the -o file.
function fakeCodex(dir, { decision = '{"decision":"ACCEPT"}', exit = 0, usage = true } = {}) {
  const bin = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(bin, `
import fs from "node:fs";
const args = process.argv.slice(2);
let input = ""; process.stdin.on("data", (d) => input += d); process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ args, input, thread: process.env.CODEX_THREAD_ID ?? null, cwd: process.cwd() }));
  const o = args[args.indexOf("-o") + 1];
  fs.writeFileSync(o, "done\\n\`\`\`json\\n" + ${JSON.stringify(decision)} + "\\n\`\`\`\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "019a-fake" }));
  ${usage ? 'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300 } }));' : ""}
  process.exit(${exit});
});`);
  return bin;
}

test("session runner: launches, strips identity, collects thread, usage and decision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-codex-"));
  const bin = fakeCodex(dir);
  const res = await runCodexSession({
    command: process.execPath,
    role: { model: "gpt-6-luna", effort: "high" },
    cwd: dir,
    prompt: "Read your card.",
    sessionDir: path.join(dir, "s1"),
    env: { ...process.env, CODEX_THREAD_ID: "parent-thread" },
    spawnImpl: (cmd, args, opts) => realSpawn(cmd, [bin, ...args], opts),
    timeoutMs: 20_000,
  });
  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
  assert.equal(seen.thread, null, "parent CODEX_THREAD_ID is not inherited");
  assert.equal(seen.input, "Read your card.");
  assert.equal(res.ok, true);
  assert.equal(res.threadId, "019a-fake");
  assert.deepEqual(res.usage, { input: 5000, cached: 4000, output: 300 });
  assert.deepEqual(res.decision, { decision: "ACCEPT" });
  assert.ok(fs.existsSync(path.join(dir, "s1", "events.jsonl")));
});

test("session runner: a non-zero exit or unparseable decision is not ok", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-codex-"));
  const bin = fakeCodex(dir, { decision: "no json here", usage: false });
  const res = await runCodexSession({
    command: process.execPath, role: { model: "gpt-6-luna", effort: "high" }, cwd: dir, prompt: "x", sessionDir: path.join(dir, "s"),
    spawnImpl: (cmd, args, opts) => realSpawn(cmd, [bin, ...args], opts), timeoutMs: 20_000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.decisionError, "DECISION_UNPARSEABLE");
  assert.equal(res.usage, null);
});

test("session runner: the GitHub token reaches the Codex process's environment and never its arguments or files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-codex-"));
  const bin = path.join(dir, "probe.mjs");
  fs.writeFileSync(bin, `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(path.join(dir, "env.json"))}, JSON.stringify({ gh: process.env.GH_TOKEN ?? null }));
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`);
  await runCodexSession({
    command: process.execPath, role: { model: "gpt-6-luna", effort: "high" }, cwd: dir, prompt: "x", sessionDir: path.join(dir, "s"),
    env: { PATH: process.env.PATH, GH_TOKEN: "parent-shell" }, githubToken: "sentinel-gh-token",
    spawnImpl: (cmd, args, opts) => realSpawn(cmd, [bin, ...args], opts), timeoutMs: 20_000,
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "env.json"), "utf8")).gh, "sentinel-gh-token");
  for (const f of fs.readdirSync(path.join(dir, "s"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "s", f), "utf8"), /sentinel-gh-token/, `${f} never holds the token`);
  }
});
