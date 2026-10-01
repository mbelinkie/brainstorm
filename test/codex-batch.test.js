import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBatch } from "../tools/codex-batch.mjs";

const root = new URL("../", import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL("docs/roadmap/config.json", root), "utf8"));
const SHA = "cd15757cd7ffa0adadb91325a9613d99c9975f2d";
const KEY = "sk-test-1234567890";

test("the batch command reaches GitHub only through the shared gate", () => {
  const text = fs.readFileSync(new URL("../tools/codex-batch.mjs", import.meta.url), "utf8");
  assert.match(text, /from "\.\.\/scripts\/roadmap\/gate\.mjs"/);
  assert.ok(!/spawn\(\s*["'`]gh["'`]/.test(text), "must not start gh directly");
  assert.ok(!/api\.github\.com/.test(text), "must not name the GitHub API host");
  assert.ok(!/github\.com\/graphql/.test(text), "must not name the GraphQL endpoint");
});

function issueNode(number, overrides = {}) {
  return {
    number, state: "OPEN", title: `PB ${number}`,
    body: "## Outcome\nDo the thing.\n## Migrations\nNone",
    labels: { nodes: [{ name: "model:standard" }, { name: "effort:high" }], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
    projectItems: {
      nodes: [{
        project: { number: 4, owner: { login: "mbelinkie" } },
        status: { name: "Ready" }, acceptance: { name: "Automated" }, priority: { name: "P1" },
      }],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

const ticket = (overrides = {}) => ({
  number: 13, title: "PB 13", body: "## Outcome\nDo the thing.\n## Migrations\nNone",
  state: "OPEN", status: "Ready", acceptance: "Automated", priority: "P1",
  labels: ["model:standard", "effort:high"], liveClaim: null, kind: "implementation", ...overrides,
});

const okLock = { acquire: () => ({ ok: true, token: "t", release: () => {} }) };

function buildFakes(overrides = {}) {
  const invocations = [];
  const mergeBodies = [];
  const blockCalls = [];
  let balanceCalls = 0;
  const balances = overrides.balances ?? ["10.00", "9.40"];
  const http = async () => {
    const total = balances[Math.min(balanceCalls, balances.length - 1)];
    balanceCalls += 1;
    return { ok: true, status: 200, json: { balance_infos: [{ currency: "USD", total_balance: total }] } };
  };

  let prCreated = false;
  const run = async (command, args, opts) => {
    invocations.push({ command, args, env: opts?.env ?? {}, input: opts?.input ?? "", cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
    if (overrides.run) return overrides.run(command, args, opts, invocations);
    if (command === "git") {
      if (args.includes("--show-toplevel")) return { status: 0, stdout: "/repo\n", stderr: "" };
      if (args.includes("--git-common-dir")) return { status: 0, stdout: "/repo/.git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "origin/main") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "npm") return { status: 0, stdout: "", stderr: "" };
    if (command === "codex") {
      if (args.includes("gpt-6.1-sol")) return overrides.solResult ?? { status: 0, stdout: "sol ok", stderr: "" };
      return overrides.workerResult ?? { status: 0, stdout: "worker ok", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const gate = {
    async read() {
      return { ok: true, data: { repository: { i13: issueNode(13, overrides.issue13) } } };
    },
    async rest({ method, path: p, body }) {
      if (method === "GET" && p.includes("/pulls")) return { ok: true, data: prCreated ? [{ number: 7, head: { sha: SHA }, html_url: "https://x/7" }] : [] };
      if (method === "POST" && p.endsWith("/pulls")) { prCreated = true; return { ok: true, data: { number: 7, html_url: "https://x/7", head: { sha: SHA } } }; }
      if (method === "GET" && p.includes("/branches/")) return { ok: true, data: { commit: { sha: SHA } } };
      if (method === "PUT" && p.includes("/merge")) { mergeBodies.push(body); return { ok: true, data: { merged: true } }; }
      throw new Error(`unexpected rest ${method} ${p}`);
    },
  };
  const lifecycle = {
    ready: async () => (overrides.readyResult ?? { ok: true }),
    inspect: async () => ({ ok: true, review: { commit: SHA }, independentVerification: overrides.verify ?? true }),
    complete: async () => ({ ok: true }),
    block: async (n, o) => { blockCalls.push({ n, o }); return { ok: true }; },
  };
  return { gate, lifecycle, run, http, invocations, mergeBodies, blockCalls, getBalanceCalls: () => balanceCalls };
}

function makeBatch(fakes, overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-"));
  const keyPath = path.join(tmp, "key");
  fs.writeFileSync(keyPath, `${KEY}\n`);
  const env = { GH_TOKEN: "gh-token", CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111", CODEX_SESSION_ID: "11111111-1111-4111-8111-111111111111", ...(overrides.env ?? {}) };
  const batch = createBatch({ config, gate: fakes.gate, lifecycle: fakes.lifecycle, run: fakes.run, http: fakes.http, env, stateDir: tmp, keyPath, lock: overrides.lock ?? okLock });
  return { batch, tmp };
}

const ctx = (extra = {}) => ({ externalAuthorized: new Set(), maxAttempts: 2, deadlineAtMs: Infinity, parentId: "11111111-1111-4111-8111-111111111111", rework: {}, ...extra });
const state = () => ({ startUsd: 10, spentUsd: 0, issues: {} });

test("first PR creation publishes, Sol-verifies, merges with the reviewed SHA, and tests origin/main in a separate worktree", async () => {
  const fakes = buildFakes();
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket(), state(), ctx());
  assert.equal(result.completed, true, JSON.stringify(result));

  assert.equal(fakes.mergeBodies.length, 1);
  assert.equal(fakes.mergeBodies[0].sha, SHA);
  assert.equal(fakes.mergeBodies[0].merge_method, "merge");

  const worker = fakes.invocations.find((i) => i.command === "codex" && i.args.includes("deepseek-v4-pro"));
  const sol = fakes.invocations.find((i) => i.command === "codex" && i.args.includes("gpt-6.1-sol"));
  assert.ok(worker, "worker launched");
  assert.ok(sol, "Sol launched");
  assert.deepEqual(worker.args.slice(0, 5), ["exec", "-p", "deepseek", "--model", "deepseek-v4-pro"]);
  assert.ok(worker.args.includes("approval_policy=never"));
  assert.ok(worker.args.includes("model_reasoning_effort=high"));
  assert.ok(worker.args.includes("workspace-write"));
  assert.ok(worker.args.includes("--add-dir"));
  assert.equal(worker.env.DEEPSEEK_API_KEY, KEY);
  assert.equal(worker.env.CODEX_THREAD_ID, undefined, "inherited execution id must be stripped");
  assert.equal(worker.env.CODEX_PARENT_THREAD_ID, "11111111-1111-4111-8111-111111111111");
  assert.equal(worker.env.GH_TOKEN, "gh-token");
  assert.ok(!worker.input.includes(KEY));

  assert.deepEqual(sol.args, ["exec", "--model", "gpt-6.1-sol", "--json"]);
  assert.equal(sol.env.DEEPSEEK_API_KEY, undefined, "Sol must never get the DeepSeek key");

  const integration = fakes.invocations.find((i) => i.command === "git" && i.args.includes("--detach"));
  assert.ok(integration, "integrated main is tested in a detached worktree");
  assert.ok(integration.args.includes("origin/main"));
  const integrationTest = fakes.invocations.find((i) => i.command === "npm" && i.args[0] === "test");
  assert.ok(integrationTest, "npm test runs on the merged main");
  assert.ok(String(integrationTest.cwd).includes("quiz-integration"), "npm test runs in the integration worktree, not the caller's checkout");
});

test("no merge when Sol exits non-zero", async () => {
  const fakes = buildFakes({ solResult: { status: 1, stdout: "failing checks", stderr: "" } });
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket(), state(), ctx());
  assert.ok(!result.completed);
  assert.equal(fakes.mergeBodies.length, 0);
  assert.ok(result.rework || result.blocked, JSON.stringify(result));
});

test("no merge when the independent verification is absent", async () => {
  const fakes = buildFakes({ verify: false });
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket(), state(), ctx());
  assert.ok(!result.completed);
  assert.equal(fakes.mergeBodies.length, 0);
  assert.ok(result.rework || result.blocked, JSON.stringify(result));
});

test("Producer acceptance publishes and waits without merging", async () => {
  const fakes = buildFakes();
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket({ acceptance: "Producer" }), state(), ctx());
  assert.equal(result.reviewed, true);
  assert.equal(result.waiting, "Producer");
  assert.equal(fakes.mergeBodies.length, 0);
});

test("a dependency-not-ready Backlog ticket is left Backlog, not Blocked, and launches no model", async () => {
  const fakes = buildFakes({ readyResult: { ok: false, code: "NOT_READY", blockers: [{ code: "PREREQ_NOT_DONE" }] } });
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket({ status: "Backlog" }), state(), ctx());
  assert.equal(result.blocked, true);
  assert.equal(result.code, "NOT_READY");
  assert.equal(result.leftBacklog, true);
  assert.equal(fakes.blockCalls.length, 0, "dependency-not-ready is not blanket Blocked");
  assert.equal(fakes.invocations.filter((i) => i.command === "codex").length, 0);
});

test("missing migration allocation blocks before launching a model", async () => {
  const fakes = buildFakes();
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket({ body: "## Outcome\nx\n## Migrations\nadd a table (number TBD)" }), state(), ctx());
  assert.equal(result.blocked, true);
  assert.equal(result.code, "MIGRATION_NUMBER_MISSING");
  assert.equal(fakes.invocations.filter((i) => i.command === "codex").length, 0);
});

test("dry-run runs the real Ready gate and migration check and launches nothing", async () => {
  const fakes = buildFakes({ readyResult: { ok: false, code: "NOT_READY", blockers: [{ code: "PREREQ_NOT_DONE" }] } });
  const { batch } = makeBatch(fakes);
  const issues = await batch.scanIssues([13]);
  const plan = await batch.dryRun(issues);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.selected, []);
  assert.ok(plan.skipped.some((s) => s.reason === "NOT_READY"), JSON.stringify(plan.skipped));
  assert.equal(fakes.invocations.length, 0, "dry-run must not launch git/npm/codex");
  assert.equal(fakes.getBalanceCalls(), 0, "dry-run must not call the provider");
});

test("a null balance total is invalid and stops before launching a model", async () => {
  const fakes = buildFakes({ balances: [null] });
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket(), state(), ctx());
  assert.equal(result.stopped, true);
  assert.equal(fakes.invocations.filter((i) => i.command === "codex").length, 0);
});

test("a failed worker session still persists its cumulative spend", async () => {
  const fakes = buildFakes({ workerResult: { status: 1, stdout: "boom", stderr: "" }, balances: ["10.00", "9.50"] });
  const { batch } = makeBatch(fakes);
  const s = state();
  const result = await batch.runTicket(ticket(), s, ctx());
  assert.ok(!result.completed);
  assert.ok(Math.abs(s.spentUsd - 0.5) < 1e-9, `spend persisted: ${s.spentUsd}`);
});

test("resume does not reset spend, and an already-at-budget batch launches nothing new", async () => {
  const fakes = buildFakes({ balances: ["9.50", "9.50"] });
  const { batch, tmp } = makeBatch(fakes);
  const s = { batchId: "b", startedAt: new Date().toISOString(), deadlineMs: 60_000, budgetUsd: 10, startUsd: 10, latestUsd: 9.5, spentUsd: 10, issues: {}, done: false };
  fs.writeFileSync(path.join(tmp, "run-state.json"), JSON.stringify(s));
  const result = await batch.runBatch({ numbers: [13], budgetUsd: 10, deadlineMs: 60_000, resume: true, soleDispatcher: true });
  assert.equal(result.ok, true);
  assert.ok(result.results.some((r) => r.stopped && r.reason === "budget exhausted"), JSON.stringify(result.results));
  assert.equal(fakes.invocations.filter((i) => i.command === "codex").length, 0);
});

test("the batch deadline kills an active worker and stops", async () => {
  const fakes = buildFakes({ workerResult: { status: 1, killed: true, stdout: "", stderr: "" } });
  const { batch } = makeBatch(fakes);
  const result = await batch.runTicket(ticket(), state(), ctx());
  assert.equal(result.stopped, true);
  assert.equal(result.deadline, true);
});

test("a non-dry-run batch needs --sole-dispatcher and a second dispatcher is refused", async () => {
  const fakes = buildFakes();
  const noDecl = makeBatch(fakes).batch;
  const a = await noDecl.runBatch({ numbers: [13] });
  assert.equal(a.code, "SOLE_DISPATCHER_REQUIRED");

  const contended = makeBatch(fakes, { lock: { acquire: () => ({ ok: false, code: "LOCK_CONTENDED", message: "held" }) } }).batch;
  const b = await contended.runBatch({ numbers: [13], soleDispatcher: true });
  assert.equal(b.code, "LOCK_CONTENDED");
});

test("corrupt state is refused, never silently reset", async () => {
  const fakes = buildFakes();
  const { batch, tmp } = makeBatch(fakes);
  fs.writeFileSync(path.join(tmp, "run-state.json"), "{ not json");
  const result = await batch.runBatch({ numbers: [13], soleDispatcher: true });
  assert.equal(result.code, "STATE_CORRUPT");
});

test("resume reuses the owned branch and worktree instead of creating a new one", async () => {
  const fakes = buildFakes();
  const { batch, tmp } = makeBatch(fakes);
  const s = {
    batchId: "b", startedAt: new Date().toISOString(), deadlineMs: 60_000, budgetUsd: 10,
    startUsd: 10, latestUsd: 9.4, spentUsd: 0.6, done: false,
    issues: { 13: { number: 13, phase: "worked", branch: "codex/pb-13-1", worktree: "../quiz-pb-13-1", attempts: 1, executionId: null, prNumber: null, reviewSha: null } },
  };
  fs.writeFileSync(path.join(tmp, "run-state.json"), JSON.stringify(s));
  await batch.runBatch({ numbers: [13], budgetUsd: 10, deadlineMs: 60_000, resume: true, soleDispatcher: true });
  const adds = fakes.invocations.filter((i) => i.command === "git" && i.args[0] === "worktree" && i.args[1] === "add" && i.args.includes("-b"));
  assert.equal(adds.length, 0, "resume must not add a second worktree");
  const workers = fakes.invocations.filter((i) => i.command === "codex" && i.args.includes("deepseek-v4-pro"));
  assert.ok(workers.length >= 1, "owned ticket is worked again, not filtered out");
});
