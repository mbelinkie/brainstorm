// End-to-end dry run of the delegation pipeline on a throwaway repository:
// real git (with a bare "origin"), real `node --test`, fake DeepSeek, fake
// Codex sessions, fake lifecycle and gate. Proves the phases connect, the
// guards gate the work, and only harness evidence moves a ticket forward.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPipeline } from "../tools/delegate/pipeline.mjs";
import { createState } from "../tools/delegate/state.mjs";
import { realExec } from "../tools/delegate/exec.mjs";

const realConfig = JSON.parse(fs.readFileSync(new URL("../tools/delegate/config.json", import.meta.url), "utf8"));
const THREAD = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "22222222-2222-4222-8222-222222222222";

function sh(cwd, cmd, args) {
  const r = realExec(cmd, args, { cwd });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-e2e-"));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  sh(root, "git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh(root, "git", ["clone", "-q", origin, repo]);
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), c); };
  w("package.json", JSON.stringify({ name: "tmp", type: "module", private: true, scripts: { test: "node --test test/*.test.js" } }, null, 2));
  w("lib.js", "export function add(a, b) {\n  return a - b;\n}\n");
  w("test/existing.test.js", 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("existing", () => { assert.equal(1, 1); });\n');
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) sh(repo, "git", ["config", k, v]);
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "init"]);
  sh(repo, "git", ["push", "-q", "origin", "main"]);
  return { root, repo, origin, base: sh(repo, "git", ["rev-parse", "HEAD"]) };
}

const ACCEPTANCE = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as mod from "../lib.js";\ntest("[A1] add sums two numbers", () => { assert.equal(mod.add(2, 3), 5); });\n';

function fakeDeepSeek({ implementations }) {
  const calls = [];
  let impl = 0;
  const reply = (model, obj, finish = "stop") => ({
    ok: true,
    body: { id: `req-${calls.length}`, model, system_fingerprint: "fp", choices: [{ finish_reason: finish, message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50, completion_tokens: 10 } },
    facts: { requestedModel: model, returnedModel: model, requestId: `req-${calls.length}`, finishReason: finish, usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 50, completion_tokens: 10 }, effort: "high", maxTokens: 1 },
  });
  return {
    calls,
    listModels: async () => ({ ok: true, ids: ["deepseek-flash", "deepseek-v4-pro"] }),
    balance: async () => ({ ok: true, usd: 18 }),
    chat: async (args) => {
      calls.push(args.purpose);
      if (args.purpose.includes("scout")) {
        return reply(args.model, {
          ticket: 7, summary: "add subtracts instead of adding",
          claims: [{ claim: "add subtracts", path: "lib.js", start: 1, end: 3, quote: "return a - b;" }],
          files_to_change: ["lib.js"], callers: [], pattern_to_reuse: null,
          proposed_cases: [{ id: "A1", kind: "normal", given: "add(2, 3)", expect: "5" }],
          open_questions: [], work_type: "coding", testable_done: "yes", testable_reason: "pure function", suggested_lane: "standard", risk_flags: [], contract_drift: [],
        });
      }
      if (args.purpose.includes("test-author")) {
        return reply(args.model, { status: "done", files: [{ path: "test/delegate-7-acceptance.test.js", content: ACCEPTANCE }], case_map: [{ case: "A1", test: "[A1] add sums two numbers", asserts: "add(2,3) === 5" }] });
      }
      const next = implementations[Math.min(impl, implementations.length - 1)];
      impl += 1;
      return reply(args.model, next);
    },
  };
}

function fakeWorld() {
  const w = { blocks: [], completes: 0, reviewCommit: null, verified: false, prs: [], merged: null };
  return w;
}

function fakeLifecycle(world) {
  return {
    inspect: async () => ({ ok: true, labels: ["model:standard", "effort:medium"], acceptanceClass: "Automated", baseline: { oid: null }, claims: { live: { executionId: THREAD } }, review: world.reviewCommit ? { commit: world.reviewCommit } : null, independentVerification: world.verified }),
    block: async (n, { cause, needs }) => { world.blocks.push({ n, cause, needs }); return { ok: true }; },
    complete: async () => { world.completes += 1; return { ok: true }; },
  };
}

function fakeGate(world, repoDir) {
  return {
    read: async () => ({ ok: true, data: { repository: { issue: { title: "add sums", body: "## Outcome\nadd(a, b) returns a + b.\n\n## Scope\n- lib.js\n" } } } }),
    rest: async ({ method, path: p, body }) => {
      if (method === "GET" && p.includes("/pulls?head=")) return { ok: true, data: world.prs.map((pr) => ({ number: 99, html_url: "https://example.invalid/pr/99", head: { ref: pr.head } })) };
      if (method === "GET" && p.endsWith("/pulls/99")) {
        const head = sh(repoDir(), "git", ["ls-remote", "origin", `refs/heads/${world.prs[0].head}`]).split(/\s/)[0];
        return { ok: true, data: { number: 99, merged: Boolean(world.merged), head: { sha: head } } };
      }
      if (method === "POST" && p.endsWith("/pulls")) { world.prs.push(body); return { ok: true, data: { number: 99, html_url: "https://example.invalid/pr/99" } }; }
      if (method === "PUT" && p.endsWith("/merge")) {
        sh(repoDir(), "git", ["push", "-q", "origin", `${body.sha}:refs/heads/main`]);
        world.merged = body.sha;
        return { ok: true, data: { merged: true } };
      }
      return { ok: false, code: "HTTP_ERROR", message: `unexpected ${method} ${p}` };
    },
  };
}

// Codex role sessions: decisions by step; the verifier really runs check-sha.
function fakeSessions(world, getPipeline, { gateDecisions = ["ACCEPT"], codexHome, tamperAtGate = false } = {}) {
  const steps = [];
  let gates = 0;
  // Real Codex writes a rollout log per thread with rate-limit snapshots.
  const writeLog = (threadId) => {
    const dir = path.join(codexHome, "sessions", "2026", "10", "02");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `rollout-2026-10-02T10-00-00-${threadId}.jsonl`), `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1790000000 }, secondary: { used_percent: 30, window_minutes: 10080 } } } })}\n`);
  };
  const inner = runner();
  return {
    steps,
    run: async (opts) => {
      const res = await inner(opts);
      writeLog(res.threadId);
      return res;
    },
  };
  function runner() {
    return async ({ prompt, resumeId }) => {
      const step = /## Step: (\S+)/.exec(prompt)[1];
      steps.push(step);
      const usage = { input: 20000, cached: 15000, output: 800 };
      if (step === "triage-and-claim") {
        return { ok: true, threadId: THREAD, usage, decision: { n: 7, fit: "ok", lane: "standard", decisions: [], escalate: null, cases: [{ id: "A1", kind: "normal", given: "add(2, 3)", expect: "5" }], scope: ["lib.js"], allow: [], claimed: true } };
      }
      if (step === "gate") {
        if (tamperAtGate) fs.appendFileSync(path.join(getPipeline()._worktreeOf(7), "lib.js"), "// controller edit\n");
        const decision = gateDecisions[Math.min(gates, gateDecisions.length - 1)];
        gates += 1;
        return { ok: true, threadId: resumeId, usage, decision: { decision, note: decision === "REPAIR" ? "make add return a + b" : "" } };
      }
      if (step === "review") {
        const sha = /--commit ([0-9a-f]{40})/.exec(prompt)[1];
        world.reviewCommit = sha;
        return { ok: true, threadId: resumeId, usage, decision: { reviewed: true } };
      }
      if (step === "verify") {
        const sha = /check-sha ([0-9a-f]{40})/.exec(prompt)[1];
        const check = getPipeline().checkSha(sha, { ticket: 7, label: `e2e-${Date.now()}` });
        world.verified = check.ok;
        world.verifySummary = check.summary;
        return { ok: true, threadId: VERIFIER, usage, decision: { verified: check.ok, sha } };
      }
      if (step === "escalation") return { ok: true, threadId: "33333333-3333-4333-8333-333333333333", usage, decision: { decision: "RECLAIM", note: "redesign" } };
      throw new Error(`unexpected step ${step}`);
    };
  }
}

function setup({ implementations, gateDecisions, tamperAtGate = false, configPatch = (c) => c }) {
  const { root, repo, base } = makeRepo();
  const home = path.join(root, "home");
  const state = createState(home);
  state.writeBatch({ startedAt: "x", deadlineMs: Date.now() + 3_600_000, baselineUsd: 18, capUsd: 10, sessionsRun: 0, creditsSpent: 0, rateReading: null });
  const config = configPatch({ ...structuredClone(realConfig), worktreeParent: ".." });
  const world = fakeWorld();
  const deepseek = fakeDeepSeek({ implementations });
  let pipeline;
  const codexHome = path.join(root, "codex-home");
  const sessions = fakeSessions(world, () => ({ ...pipeline, _worktreeOf: (n) => state.readTicket(n).worktree }), { gateDecisions, codexHome, tamperAtGate });
  // worktree-setup and npm ci need a real npm project; they are not under test here.
  const exec = (cmd, args, opts) => {
    if (cmd === "node" && args[0] === "tools/worktree-setup.mjs") return { status: 0, stdout: "PASS", stderr: "" };
    if (cmd === "npm" && args[0] === "ci") return { status: 0, stdout: "", stderr: "" };
    return realExec(cmd, args, opts);
  };
  pipeline = createPipeline({
    config, repoRoot: repo, state, exec, gate: fakeGate(world, () => repo), lifecycle: fakeLifecycle(world), deepseek,
    runSession: sessions.run, env: { ...process.env, CODEX_HOME: codexHome }, sleep: async () => {},
  });
  return { pipeline, state, world, deepseek, sessions, base, repo, root, home };
}

const FIX = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a + b;" }], summary: "add now sums" };

test("e2e: a ticket goes from intake to finished on harness evidence only", async () => {
  const { pipeline, state, world, deepseek, sessions, base, repo } = setup({ implementations: [FIX] });
  let t = await pipeline.intake(7, { number: 7, baseline: base, acceptance: "Automated" });
  t = await pipeline.advance(t);
  assert.equal(t.phase, "finished", JSON.stringify(t.blocked ?? t.ladder));
  assert.deepEqual(sessions.steps, ["triage-and-claim", "gate", "review", "verify"]);
  assert.equal(t.ladder.outcome, "GREEN");
  assert.equal(t.attempts.length, 1);
  assert.equal(t.redOnBase, "1/1 fail by assertion on base");
  assert.match(t.lastAcceptance, /A1 PASS/);
  assert.equal(world.merged, t.publishedSha, "the verified SHA is what was merged");
  assert.equal(world.completes, 1);
  assert.match(world.verifySummary, /RESULT: PASS/);
  assert.match(world.verifySummary, /acceptance A1: PASS/);
  // The published branch has the tests commit, the fix, and the evidence file.
  const log = sh(repo, "git", ["log", "--format=%s", `${base}..origin/main`]).split("\n");
  assert.deepEqual(log, ["docs: delegation evidence for #7", "feat: add sums (#7)", "test: acceptance cases for #7"]);
  assert.equal(fs.readFileSync(path.join(t.worktree, "lib.js"), "utf8"), "export function add(a, b) {\n  return a + b;\n}\n");
  assert.ok(fs.existsSync(path.join(t.worktree, "docs/delegation/evidence/7.md")));
  assert.ok(deepseek.calls.some((c) => c.includes("scout")) && deepseek.calls.some((c) => c.includes("test-author")));
  assert.equal(t.codexSessions.length, 4);
  assert.ok(fs.readFileSync(state.ledgerFile, "utf8").includes("finished"));
  assert.equal(world.prs.length, 1);
  assert.doesNotMatch(world.prs[0].body, /\b(?:closes|fixes|resolves) #\d/i, "no closing keywords");

  // Resume after an uncertain PR write: the harness re-reads and finds the PR instead of opening a second one.
  const again = await pipeline.openPr({ ...t, prNumber: undefined, prUrl: undefined, phase: "pushed" });
  assert.equal(again.prNumber, 99);
  assert.equal(world.prs.length, 1, "no duplicate PR");
});

test("e2e: a guard failure climbs the ladder; editing the locked test is never accepted", async () => {
  const tamper = { status: "done", files: [{ path: "test/delegate-7-acceptance.test.js", content: "// gone\n" }] };
  const outOfScope = { status: "done", files: [{ path: "other.js", content: "x\n" }] };
  const syntaxError = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a + ;" }] };
  const { pipeline, base } = setup({ implementations: [tamper, outOfScope, syntaxError, FIX] });
  let t = await pipeline.intake(7, { number: 7, baseline: base, acceptance: "Automated" });
  t = await pipeline.advance(t);
  assert.equal(t.phase, "finished", JSON.stringify(t.blocked ?? t.ladder));
  assert.deepEqual(t.attempts.map((a) => a.result), ["apply-rejected", "apply-rejected", "FAILED", "GREEN"]);
  assert.deepEqual(t.attempts.map((a) => a.model), ["deepseek-flash", "deepseek-flash", "deepseek-v4-pro", "deepseek-v4-pro"]);
  assert.match(t.attempts[0].message, /locked acceptance file/);
  assert.ok(t.attempts[2].guardLines.some((l) => l.startsWith("FAIL syntax")));
});

test("e2e: a capped ladder cannot be accepted; the Controller's ACCEPT becomes an escalation", async () => {
  const wrong = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a * b;" }] };
  const { pipeline, world, sessions, base } = setup({ implementations: [wrong], gateDecisions: ["ACCEPT"] });
  let t = await pipeline.intake(7, { number: 7, baseline: base, acceptance: "Automated" });
  t = await pipeline.advance(t);
  assert.equal(t.ladder.outcome, "CAPPED");
  assert.equal(t.phase, "blocked");
  assert.ok(sessions.steps.includes("escalation"), "Sol was consulted");
  assert.equal(world.merged, null);
  assert.equal(world.completes, 0);
  assert.ok(world.blocks.some((b) => /reclaim/i.test(b.cause)));
});

test("e2e: one REPAIR reruns from the Pro rung with the note, then succeeds", async () => {
  const wrong = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a * b;" }] };
  const { pipeline, base, sessions } = setup({ implementations: [wrong, wrong, wrong, wrong, FIX], gateDecisions: ["REPAIR", "ACCEPT"] });
  let t = await pipeline.intake(7, { number: 7, baseline: base, acceptance: "Automated" });
  t = await pipeline.advance(t);
  assert.equal(t.phase, "finished", JSON.stringify(t.blocked ?? t.ladder));
  assert.equal(t.repairs, 1);
  assert.equal(t.attempts.at(-1).model, "deepseek-v4-pro");
  assert.deepEqual(sessions.steps, ["triage-and-claim", "gate", "gate", "review", "verify"]);
});

test("e2e: a design-labelled ticket is flagged at intake and never claimed", async () => {
  const s = setup({ implementations: [FIX] });
  const flaggedLifecycle = { ...fakeLifecycle(s.world), inspect: async () => ({ ok: true, labels: ["type:design"], acceptanceClass: "Producer", claims: { live: null } }) };
  const pipe = createPipeline({
    config: { ...structuredClone(realConfig), worktreeParent: ".." }, repoRoot: s.repo, state: s.state, exec: realExec,
    gate: fakeGate(s.world, () => s.repo), lifecycle: flaggedLifecycle, deepseek: s.deepseek, runSession: s.sessions.run, env: process.env,
  });
  const t = await pipe.intake(7, { number: 7, baseline: s.base, acceptance: "Producer" });
  assert.equal(t.phase, "flagged");
  assert.equal(s.sessions.steps.length, 0, "no Codex session ran");
  assert.equal(s.deepseek.calls.length, 0, "no DeepSeek request ran");
  assert.match(s.world.blocks[0].cause, /Gate 0/);
  assert.ok(!fs.existsSync(path.join(s.root, "quiz-delegate-7")), "no worktree was created");
});

test("e2e: a role session that edits the worktree blocks the ticket", async () => {
  const { pipeline, world, base } = setup({ implementations: [FIX], tamperAtGate: true });
  let t = await pipeline.intake(7, { number: 7, baseline: base, acceptance: "Automated" });
  t = await pipeline.advance(t);
  assert.equal(t.phase, "blocked");
  assert.match(t.blocked.cause, /WORKTREE_CHANGED/);
  assert.equal(world.prs.length, 0, "nothing was published");
});
