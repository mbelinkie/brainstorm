// Run with `npm run test:harness` (about 50 seconds). Kept out of `npm test` so
// product tickets, which run the suite on every ladder attempt, don't pay for it.
//
// End-to-end runs of the delegation pipeline on a throwaway repository: real
// git (with a bare "origin"), real `node --test`, fake DeepSeek, fake Codex
// sessions, fake lifecycle and gate. Proves the phases connect, the guards
// gate the work, and only harness evidence moves a ticket forward.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPipeline } from "../../tools/delegate/pipeline.mjs";
import { createState } from "../../tools/delegate/state.mjs";
import { realExec } from "../../tools/delegate/exec.mjs";
import { loop } from "../../tools/delegate/run.mjs";

const realConfig = JSON.parse(fs.readFileSync(new URL("../../tools/delegate/config.json", import.meta.url), "utf8"));
const LUNA = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "22222222-2222-4222-8222-222222222222";
const SOL = "33333333-3333-4333-8333-333333333333";

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
  return { root, repo, base: sh(repo, "git", ["rev-parse", "HEAD"]) };
}

// ---- acceptance tests the fake test author writes, by case id ----------------

const TEST_HEAD = 'import test from "node:test";\nimport assert from "node:assert/strict";\n';
const CASE_TESTS = {
  A1: 'test("[A1] add sums two numbers", async () => { const mod = await import("../lib.js"); assert.equal(mod.add(2, 3), 5); });\n',
  A2: 'test("[A2] mul multiplies", async () => { const mod = await import("../lib2.js").catch(() => ({})); assert.equal(typeof mod.mul, "function"); assert.equal(mod.mul(2, 3), 6); });\n',
};
const STRONG_A1 = 'test("[A1] add sums two numbers", async () => { const mod = await import("../lib.js"); assert.equal(mod.add(2, 3), 5); assert.equal(mod.add(1, 1), 2); assert.equal(mod.add(-4, 4), 0); });\n';

const FIX = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a + b;" }], summary: "add now sums" };
const WRONG = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a * b;" }] };
const MUL = { status: "done", files: [{ path: "lib2.js", content: "export function mul(a, b) {\n  return a * b;\n}\n" }] };
const KILLED_MUTANT = { name: "mul-instead", mistake: "multiplies", edits: [{ path: "lib.js", old: "return a + b;", new: "return a * b;" }] };
const CONSTANT_MUTANT = { name: "constant", mistake: "returns a constant", edits: [{ path: "lib.js", old: "return a + b;", new: "return 5;" }] };

function fakeDeepSeek(script) {
  const calls = [];
  let impl = 0;
  let review = 0;
  const reply = (model, obj) => ({
    ok: true,
    body: { id: `req-${calls.length}`, model, system_fingerprint: "fp", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(obj) } }] },
    facts: { requestedModel: model, returnedModel: model, requestId: `req-${calls.length}`, finishReason: "stop", usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 50, completion_tokens: 10 }, effort: "high", maxTokens: 1 },
  });
  return {
    calls,
    listModels: async () => ({ ok: true, ids: ["deepseek-flash", "deepseek-v4-pro"] }),
    balance: async () => ({ ok: true, usd: 18 }),
    chat: async (args) => {
      const purpose = args.purpose;
      calls.push(purpose);
      const packet = args.messages[1].content;
      if (purpose.includes("scout")) return reply(args.model, script.scout ?? scoutFor([{ id: "A1", given: "add(2, 3)", expect: "5" }]));
      if (purpose.includes("strengthen")) {
        const target = /exactly one new file: (\S+)/.exec(packet)[1];
        return reply(args.model, { status: "done", files: [{ path: target, content: TEST_HEAD + STRONG_A1 }] });
      }
      if (purpose.includes("test-author")) {
        const target = /exactly one new file: (\S+)/.exec(packet)[1];
        const ids = [...packet.matchAll(/^- \[(A\d+)\]/gm)].map((m) => m[1]);
        return reply(args.model, { status: "done", files: [{ path: target, content: TEST_HEAD + ids.map((id) => CASE_TESTS[id]).join("") }], case_map: ids.map((id) => ({ case: id, test: `[${id}]`, asserts: "behavior" })) });
      }
      if (purpose.includes("mutants")) return reply(args.model, { mutants: script.mutants ?? [KILLED_MUTANT] });
      if (purpose.includes("pre-review")) {
        const list = script.preReview ?? [[]];
        const findings = list[Math.min(review, list.length - 1)];
        review += 1;
        return reply(args.model, { findings });
      }
      const list = script.implementations ?? [FIX];
      const next = typeof list === "function" ? list(packet, impl) : list[Math.min(impl, list.length - 1)];
      impl += 1;
      return reply(args.model, next);
    },
  };
}

function scoutFor(cases, extra = {}) {
  return {
    ticket: 7, summary: "add subtracts instead of adding",
    claims: [{ claim: "add subtracts", path: "lib.js", start: 1, end: 3, quote: "return a - b;" }],
    files_to_change: ["lib.js"], callers: [], pattern_to_reuse: null, proposed_cases: cases,
    open_questions: [], work_type: "coding", testable_done: "yes", testable_reason: "pure function", suggested_lane: "standard", risk_flags: [], contract_drift: [],
    ...extra,
  };
}

function fakeLifecycle(world) {
  return {
    inspect: async (n) => ({ ok: true, labels: world.labels?.[n] ?? ["model:standard", "effort:medium"], acceptanceClass: "Automated", baseline: { oid: null }, claims: { live: world.claims[n] ? { executionId: world.claims[n] } : null }, review: world.reviews[n] ? { commit: world.reviews[n] } : null, independentVerification: Boolean(world.verified[n]) }),
    block: async (n, { cause, needs }) => { world.blocks.push({ n, cause, needs }); return { ok: true }; },
    complete: async (n) => { world.completes.push(n); return { ok: true }; },
  };
}

function fakeGate(world, repoDir) {
  return {
    read: async ({ variables }) => ({ ok: true, data: { repository: { issue: { title: `ticket ${variables.n}`, body: "## Outcome\nadd(a, b) returns a + b.\n\n## Scope\n- lib.js\n", projectItems: { nodes: [{ project: { number: 4 }, workstream: { name: world.category ?? "Backend/Scoring" } }] } } } } }),
    rest: async ({ method, path: p, body }) => {
      if (method === "GET" && p.includes("/pulls?head=")) {
        const branch = decodeURIComponent(p.split("head=")[1].split("&")[0]).split(":")[1];
        const found = world.prs.find((pr) => pr.head === branch);
        return { ok: true, data: found ? [{ number: found.number, html_url: `https://example.invalid/pr/${found.number}`, head: { ref: branch } }] : [] };
      }
      if (method === "POST" && p.endsWith("/pulls")) {
        const number = 100 + world.prs.length;
        world.prs.push({ ...body, number });
        return { ok: true, data: { number, html_url: `https://example.invalid/pr/${number}` } };
      }
      const m = /\/pulls\/(\d+)(\/merge)?$/.exec(p);
      const pr = m && world.prs.find((x) => x.number === Number(m[1]));
      if (method === "GET" && pr) {
        const head = sh(repoDir(), "git", ["ls-remote", "origin", `refs/heads/${pr.head}`]).split(/\s/)[0];
        return { ok: true, data: { number: pr.number, merged: Boolean(pr.merged), head: { sha: head } } };
      }
      if (method === "PUT" && pr && m[2]) {
        sh(repoDir(), "git", ["fetch", "-q", "origin"]);
        sh(repoDir(), "git", ["checkout", "-q", "--detach", "origin/main"]);
        sh(repoDir(), "git", ["merge", "-q", "--no-ff", "-m", `Merge PR #${pr.number}`, body.sha]);
        sh(repoDir(), "git", ["push", "-q", "origin", "HEAD:refs/heads/main"]);
        pr.merged = true;
        world.merged.push(body.sha);
        return { ok: true, data: { merged: true } };
      }
      return { ok: false, code: "HTTP_ERROR", message: `unexpected ${method} ${p}` };
    },
  };
}

// Codex role sessions. Decisions are scripted per step; the verifier really runs check-sha.
function fakeSessions(world, getPipeline, opts) {
  const steps = [];
  const gates = {};
  const writeLog = (threadId) => {
    const dir = path.join(opts.codexHome, "sessions", "2026", "10", "02");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `rollout-2026-10-02T10-00-00-${threadId}.jsonl`), `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 1790000000 }, secondary: { used_percent: 30, window_minutes: 10080 } } } })}\n`);
  };
  const ticketOf = (prompt) => Number(/lifecycle\.mjs (?:claim|review|verify) (\d+)/.exec(prompt)?.[1] ?? /--ticket (\d+)/.exec(prompt)?.[1] ?? /#(\d+)/.exec(prompt)?.[1] ?? 7);
  const triageDecision = (n) => ({
    n, fit: "ok", lane: opts.lane ?? "standard", decisions: [], escalate: null, cases: opts.cases ?? [{ id: "A1", kind: "normal", given: "add(2, 3)", expect: "5" }],
    scope: ["lib.js"], allow: [], slices: opts.slices ?? null,
  });
  let threadSeq = 0;
  const thread = (base) => (opts.uniqueThreads ? `${base.slice(0, -4)}${String(++threadSeq).padStart(4, "0")}` : base);
  const run = async ({ prompt, resumeId, cwd }) => {
    const step = /## Step: (\S+)/.exec(prompt)[1];
    steps.push(step);
    const n = ticketOf(prompt);
    const usage = { input: 20000, cached: 15000, output: 800 };
    if (opts.rejectModelAt === step) return { ok: false, threadId: thread(LUNA), usage: null, decision: null, errors: ["The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."] };
    if (opts.tamperAt === step) fs.appendFileSync(path.join(getPipeline().worktreeOf(n), "lib.js"), "// controller edit\n");
    if (step === "triage-and-claim") {
      const d = triageDecision(n);
      const claims = d.lane !== "protected";
      const id = thread(LUNA);
      if (claims) world.claims[n] = id;
      return { ok: true, threadId: id, usage, decision: { ...d, claimed: claims } };
    }
    if (step === "batch-triage") {
      const ns = [...prompt.matchAll(/### Ticket #(\d+)/g)].map((x) => Number(x[1]));
      return { ok: true, threadId: "44444444-4444-4444-8444-444444444444", usage, decision: { tickets: ns.map(triageDecision) } };
    }
    if (step === "claim") { const id = thread(LUNA); world.claims[n] = id; return { ok: true, threadId: id, usage, decision: { claimed: true } }; }
    if (step === "design-and-claim") {
      world.claims[n] = SOL;
      return { ok: true, threadId: SOL, usage, decision: { ...triageDecision(n), lane: "protected", real_process_checks: ["launch a child with sentinel env vars"], claimed: true } };
    }
    if (step === "gate") {
      gates[n] = (gates[n] ?? 0) + 1;
      const list = opts.gateDecisions ?? ["ACCEPT"];
      const decision = list[Math.min(gates[n] - 1, list.length - 1)];
      return { ok: true, threadId: resumeId, usage, decision: { decision, note: decision === "REPAIR" ? "make add return a + b" : "" } };
    }
    if (step === "real-process-check") return { ok: true, threadId: resumeId, usage, decision: { passed: true, evidence: ["node child.mjs -> forbidden sentinel absent"] } };
    if (step === "review") {
      world.reviews[n] = /--commit ([0-9a-f]{40})/.exec(prompt)[1];
      return { ok: true, threadId: resumeId, usage, decision: { reviewed: true } };
    }
    if (step === "verify") {
      const sha = /check-sha ([0-9a-f]{40})/.exec(prompt)[1];
      const check = getPipeline().checkSha(sha, { ticket: n, label: `e2e-${n}-${Date.now()}` });
      world.verified[n] = check.ok;
      world.verifySummary = check.summary;
      return { ok: true, threadId: VERIFIER, usage, decision: { verified: check.ok, sha } };
    }
    if (step === "escalation") return { ok: true, threadId: "55555555-5555-4555-8555-555555555555", usage, decision: { decision: "RECLAIM", note: "redesign" } };
    if (step === "audit") { world.audits.push(n); return { ok: true, threadId: "66666666-6666-4666-8666-666666666666", usage, decision: { defect: false, detail: "fine", recommendation: "none" } }; }
    throw new Error(`unexpected step ${step} (cwd ${cwd})`);
  };
  return {
    steps,
    run: async (args) => {
      const res = await run(args);
      writeLog(res.threadId);
      return res;
    },
  };
}

function setup(opts = {}) {
  const { root, repo, base } = makeRepo();
  const home = path.join(root, "home");
  const state = createState(home);
  state.writeBatch({ startedAt: "x", deadlineMs: Date.now() + 3_600_000, baselineUsd: 18, capUsd: 10, sessionsRun: 0, creditsSpent: 0, rateReading: null });
  const config = { ...structuredClone(realConfig), worktreeParent: "..", ...(opts.config ?? {}) };
  const world = { blocks: [], completes: [], prs: [], merged: [], claims: {}, reviews: {}, verified: {}, audits: [], category: opts.category, labels: opts.labels };
  const deepseek = fakeDeepSeek(opts);
  const codexHome = path.join(root, "codex-home");
  let pipeline;
  const sessions = fakeSessions(world, () => ({ ...pipeline, worktreeOf: (n) => state.readTicket(n).worktree }), { ...opts, codexHome });
  // worktree-setup and npm ci need a real npm project; they are not under test here.
  const exec = (cmd, args, o) => {
    if (cmd === "node" && args[0] === "tools/worktree-setup.mjs") return { status: 0, stdout: "PASS", stderr: "" };
    if (cmd === "npm" && args[0] === "ci") return { status: 0, stdout: "", stderr: "" };
    return realExec(cmd, args, o);
  };
  pipeline = createPipeline({
    config, repoRoot: repo, state, exec, gate: fakeGate(world, () => repo), lifecycle: fakeLifecycle(world), deepseek,
    runSession: sessions.run, env: { ...process.env, CODEX_HOME: codexHome }, sleep: async () => {}, projectNumber: 4, stopBeforeMerge: opts.noMerge === true,
  });
  return { pipeline, state, world, deepseek, sessions, base, repo, root, config };
}

async function runTicket(s, n = 7) {
  const t = await s.pipeline.intake(n, { number: n, baseline: s.base, acceptance: "Automated" });
  return s.pipeline.advance(t);
}

const why = (t) => JSON.stringify(t.blocked ?? t.ladder ?? t.phase);

// ---- tests -----------------------------------------------------------------------

test("e2e: intake to finished on harness evidence, with mutants, pre-review and the audit sample", async () => {
  const s = setup();
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  assert.deepEqual(s.sessions.steps, ["triage-and-claim", "gate", "review", "verify", "audit"]);
  assert.equal(t.category, "Backend/Scoring");
  assert.equal(t.doneSlices.length, 1);
  assert.equal(t.doneSlices[0].ladder.outcome, "GREEN");
  assert.deepEqual(t.doneSlices[0].mutants.survivors, []);
  assert.equal(t.doneSlices[0].mutants.killed, 1);
  assert.deepEqual(t.doneSlices[0].preReview.findings, []);
  assert.equal(s.world.merged[0], t.publishedSha, "the verified SHA is what was merged");
  assert.deepEqual(s.world.completes, [7]);
  assert.match(s.world.verifySummary, /RESULT: PASS/);
  assert.match(s.world.verifySummary, /acceptance A1: PASS/);
  const log = sh(s.repo, "git", ["log", "--format=%s", "--first-parent", "-1", "origin/main"]);
  assert.match(log, /Merge PR/);
  const branchLog = sh(s.repo, "git", ["log", "--format=%s", `${s.base}..${t.publishedSha}`]).split("\n");
  assert.deepEqual(branchLog, ["docs: delegation evidence for #7", "feat: ticket 7 (#7)", "test: acceptance cases for #7 S1"]);
  assert.equal(fs.readFileSync(path.join(t.worktree, "lib.js"), "utf8"), "export function add(a, b) {\n  return a + b;\n}\n");
  assert.deepEqual(s.world.audits, [7], "the first Luna accept is in the pilot audit sample");
  const ledger = fs.readFileSync(s.state.ledgerFile, "utf8");
  assert.match(ledger, /finished/);
  assert.match(ledger, /clean/);
  assert.ok(s.deepseek.calls.some((c) => c.includes("mutants")) && s.deepseek.calls.some((c) => c.includes("pre-review")));
  assert.doesNotMatch(s.world.prs[0].body, /\b(?:closes|fixes|resolves) #\d/i, "no closing keywords");
  // Resume after an uncertain PR write: the harness re-reads and finds the PR instead of opening a second one.
  const again = await s.pipeline.openPr({ ...t, prNumber: undefined, prUrl: undefined, phase: "pushed" });
  assert.equal(again.prNumber, 100);
  assert.equal(s.world.prs.length, 1, "no duplicate PR");
});

test("e2e: a surviving mutant gets the tests strengthened once, re-proven red on base, re-locked and committed", async () => {
  const s = setup({ mutants: [CONSTANT_MUTANT, KILLED_MUTANT] });
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  const m = t.doneSlices[0].mutants;
  assert.equal(m.strengthened, true);
  assert.equal(m.killed, 2);
  assert.deepEqual(m.survivors, []);
  const branchLog = sh(s.repo, "git", ["log", "--format=%s", `${s.base}..${t.publishedSha}`]).split("\n");
  assert.ok(branchLog.includes("test: strengthen acceptance for #7 S1"), branchLog.join(" | "));
  assert.match(fs.readFileSync(path.join(t.worktree, "test/delegate-7-s1-acceptance.test.js"), "utf8"), /add\(1, 1\), 2/);
});

test("e2e: pre-review findings trigger one extra attempt; a regressing attempt keeps the green version", async () => {
  const finding = [{ path: "lib.js", line: 2, issue: "caller not updated" }];
  const fixedTwice = setup({ preReview: [finding, []], implementations: [FIX, FIX] });
  const t1 = await runTicket(fixedTwice);
  assert.equal(t1.phase, "finished", why(t1));
  assert.equal(t1.doneSlices[0].preReview.extraAttempt, "fixed");
  assert.deepEqual(t1.doneSlices[0].preReview.findings, []);

  const regresses = setup({ preReview: [finding], implementations: [FIX, WRONG] });
  const t2 = await runTicket(regresses);
  assert.equal(t2.phase, "finished", why(t2));
  assert.match(t2.doneSlices[0].preReview.extraAttempt, /kept the previous green version/);
  assert.equal(t2.doneSlices[0].preReview.findings.length, 1, "remaining findings reach the bundle");
  assert.ok(fs.readFileSync(path.join(t2.worktree, "lib.js"), "utf8").includes("a + b"), "the green version was published");
});

test("e2e: a guard failure climbs the ladder; editing the locked test is never accepted", async () => {
  const tamper = { status: "done", files: [{ path: "test/delegate-7-s1-acceptance.test.js", content: "// gone\n" }] };
  const outOfScope = { status: "done", files: [{ path: "other.js", content: "x\n" }] };
  const syntaxError = { status: "done", edits: [{ path: "lib.js", old: "return a - b;", new: "return a + ;" }] };
  const s = setup({ implementations: [tamper, outOfScope, syntaxError, FIX] });
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  const attempts = t.doneSlices[0].attempts;
  assert.deepEqual(attempts.map((a) => a.result), ["apply-rejected", "apply-rejected", "FAILED", "GREEN"]);
  assert.deepEqual(attempts.map((a) => a.model), ["deepseek-flash", "deepseek-flash", "deepseek-v4-pro", "deepseek-v4-pro"]);
  assert.match(attempts[0].message, /locked acceptance file/);
  assert.ok(attempts[2].guardLines.some((l) => l.startsWith("FAIL syntax")));
});

test("e2e: a capped ladder cannot be accepted; the Controller's ACCEPT becomes an escalation", async () => {
  const s = setup({ implementations: [WRONG], gateDecisions: ["ACCEPT"] });
  const t = await runTicket(s);
  assert.equal(t.ladder.outcome, "CAPPED");
  assert.equal(t.phase, "blocked");
  assert.ok(s.sessions.steps.includes("escalation"), "Sol was consulted");
  assert.deepEqual(s.world.merged, []);
  assert.ok(s.world.blocks.some((b) => /reclaim/i.test(b.cause)));
  assert.equal(t.mutants, null, "no mutant check on a ladder that is not green");
});

test("e2e: one REPAIR reruns from the Pro rung with the note, then succeeds", async () => {
  const s = setup({ implementations: [WRONG, WRONG, WRONG, WRONG, FIX], gateDecisions: ["REPAIR", "ACCEPT"] });
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  assert.equal(t.doneSlices[0].repairs, 1);
  assert.equal(t.doneSlices[0].attempts.at(-1).model, "deepseek-v4-pro");
  assert.deepEqual(s.sessions.steps.slice(0, 3), ["triage-and-claim", "gate", "gate"]);
});

test("e2e: two slices run in order, each with its own locked tests, commits and gate", async () => {
  const cases = [{ id: "A1", kind: "normal", given: "add(2, 3)", expect: "5" }, { id: "A2", kind: "normal", given: "mul(2, 3)", expect: "6" }];
  const slices = [{ id: "S1", goal: "fix add", scope: ["lib.js"], cases: ["A1"] }, { id: "S2", goal: "add mul", scope: ["lib2.js"], cases: ["A2"] }];
  const s = setup({ cases, slices, implementations: (packet) => (packet.includes("S2: add mul") ? MUL : FIX), mutants: [] });
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  assert.deepEqual(t.doneSlices.map((x) => x.id), ["S1", "S2"]);
  assert.deepEqual(s.sessions.steps, ["triage-and-claim", "gate", "gate", "review", "verify", "audit"]);
  const branchLog = sh(s.repo, "git", ["log", "--format=%s", `${s.base}..${t.publishedSha}`]).split("\n").reverse();
  assert.deepEqual(branchLog, [
    "test: acceptance cases for #7 S1",
    "feat: ticket 7 (#7) [S1: fix add]",
    "test: acceptance cases for #7 S2",
    "feat: ticket 7 (#7) [S2: add mul]",
    "docs: delegation evidence for #7",
  ]);
  assert.deepEqual(t.lockedFiles, ["test/delegate-7-s1-acceptance.test.js", "test/delegate-7-s2-acceptance.test.js"]);
  assert.match(s.world.verifySummary, /acceptance A1: PASS\nacceptance A2: PASS/);
});

test("e2e: a Protected ticket goes to Sol: Sol claims, gates, runs real-process checks and reviews; no audit", async () => {
  const s = setup({ lane: "protected" });
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  assert.equal(t.claimant.role, "sol");
  assert.deepEqual(s.sessions.steps, ["triage-and-claim", "design-and-claim", "gate", "real-process-check", "review", "verify"]);
  assert.deepEqual(t.realProcessEvidence, ["node child.mjs -> forbidden sentinel absent"]);
  assert.deepEqual(s.world.audits, [], "Sol-claimed tickets are not in the Luna audit sample");
  assert.match(fs.readFileSync(path.join(t.worktree, "docs/delegation/evidence/7.md"), "utf8"), /Sol real-process checks/);
});

test("e2e: a category the owner raised to Protected skips Luna entirely", async () => {
  const s = setup({ category: "Platform/Ops", config: { categoryOverrides: { "Platform/Ops": { minLane: "protected" } } } });
  const t = await runTicket(s);
  assert.equal(t.phase, "finished", why(t));
  assert.equal(s.sessions.steps[0], "design-and-claim");
  assert.match(t.solReason, /category override/);
});

test("e2e: batched triage decides several tickets in one session, then each is claimed and worked", async () => {
  const s = setup({ config: { batch: { ...realConfig.batch, triageBatchSize: 3 } }, uniqueThreads: true, mutants: [] });
  const planner = { plan: async () => {
    const queue = [7, 8].filter((n) => !s.state.readTicket(n)).map((number) => ({ number, baseline: s.base, acceptance: "Automated" }));
    return { selected: queue[0] ?? null, readyQueue: queue, promotionCandidates: [] };
  } };
  const lines = [];
  const code = await loop({ config: s.config, state: s.state, planner, pipeline: s.pipeline }, (l) => lines.push(l), Date.now);
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(s.sessions.steps.filter((x) => x === "batch-triage").length, 1, lines.join("\n"));
  assert.equal(s.sessions.steps.filter((x) => x === "claim").length, 2);
  assert.equal(s.state.readTicket(7).phase, "finished", why(s.state.readTicket(7)));
  assert.equal(s.state.readTicket(8).phase, "finished", why(s.state.readTicket(8)));
  const shared = s.state.readTicket(7).codexSessions.find((x) => x.step === "batch-triage");
  assert.equal(shared.shared, 2, "the batched triage cost is split across its tickets");
});

test("e2e: a design-labelled ticket is flagged at intake and never claimed", async () => {
  const s = setup({ labels: { 7: ["type:design"] } });
  const t = await s.pipeline.intake(7, { number: 7, baseline: s.base, acceptance: "Producer" });
  assert.equal(t.phase, "flagged");
  assert.equal(s.sessions.steps.length, 0, "no Codex session ran");
  assert.equal(s.deepseek.calls.length, 0, "no DeepSeek request ran");
  assert.match(s.world.blocks[0].cause, /Gate 0/);
  assert.ok(!fs.existsSync(path.join(s.root, "quiz-delegate-7")), "no worktree was created");
});

test("e2e: a role session that edits the worktree blocks the ticket", async () => {
  const s = setup({ tamperAt: "gate" });
  const t = await runTicket(s);
  assert.equal(t.phase, "blocked");
  assert.match(t.blocked.cause, /WORKTREE_CHANGED/);
  assert.equal(s.world.prs.length, 0, "nothing was published");
});

test("e2e: files changed by an interrupted check are restored on resume; a retry gets fresh names", async () => {
  const s = setup();
  const t = await runTicket(s);
  const file = path.join(t.worktree, "lib.js");
  const good = fs.readFileSync(file, "utf8");
  const tests = path.join(t.worktree, "test/delegate-7-s1-acceptance.test.js");
  const goodTests = fs.readFileSync(tests, "utf8");
  // A crash inside a nested check: outer backup holds the tests, inner backup holds lib.js.
  fs.writeFileSync(path.join(s.state.ticketDir(7), "scratch-0.json"), JSON.stringify({ "test/delegate-7-s1-acceptance.test.js": goodTests }));
  fs.writeFileSync(path.join(s.state.ticketDir(7), "scratch-1.json"), JSON.stringify({ "lib.js": good }));
  fs.writeFileSync(file, "export function add() { return 5; }\n");
  fs.writeFileSync(tests, "// half-written\n");
  s.pipeline.recoverScratch(t);
  assert.equal(fs.readFileSync(file, "utf8"), good);
  assert.equal(fs.readFileSync(tests, "utf8"), goodTests);
  assert.deepEqual(fs.readdirSync(s.state.ticketDir(7)).filter((f) => f.startsWith("scratch")), []);

  // The same ticket becoming Ready again starts a second attempt beside the first, deleting nothing.
  const retry = await s.pipeline.intake(7, { number: 7, baseline: s.base, acceptance: "Automated" });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.branch, "codex/delegate-7-2");
  assert.ok(fs.existsSync(t.worktree), "the first worktree is untouched");
});

test("e2e: --no-merge stops a verified Automated ticket before merge and leaves next steps", async () => {
  const s = setup({ noMerge: true });
  const t = await runTicket(s);
  assert.equal(t.phase, "awaiting-owner", why(t));
  assert.equal(t.stoppedBeforeMerge, true);
  assert.deepEqual(s.world.merged, [], "nothing merged");
  assert.deepEqual(s.world.completes, [], "not completed");
  assert.equal(s.world.verified[7], true, "it was still independently verified");
  assert.match(fs.readFileSync(path.join(s.state.ticketDir(7), "signoff.md"), "utf8"), /lifecycle\.mjs complete 7/);
});

// Pilot regression: a rejected model reported "over budget: usage missing" instead of Codex's own error.
test("e2e: a session Codex rejects reports Codex's error, not a budget problem", async () => {
  const s = setup({ rejectModelAt: "triage-and-claim" });
  const t = await runTicket(s);
  assert.equal(t.phase, "blocked");
  assert.match(t.blocked.cause, /not supported when using Codex with a ChatGPT account/);
  assert.doesNotMatch(t.blocked.cause, /budget|usage missing/);
});
