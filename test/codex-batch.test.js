import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBatch } from "../tools/codex-batch.mjs";

const root = new URL("../", import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL("docs/roadmap/config.json", root), "utf8"));
const SHA = "cd15757cd7ffa0adadb91325a9613d99c9975f2d";

test("the batch command reaches GitHub only through the shared gate", () => {
  const text = fs.readFileSync(new URL("../tools/codex-batch.mjs", import.meta.url), "utf8");
  assert.match(text, /from "\.\.\/scripts\/roadmap\/gate\.mjs"/);
  assert.ok(!/spawn\(\s*["'`]gh["'`]/.test(text), "must not start gh directly");
  assert.ok(!/api\.github\.com/.test(text), "must not name the GitHub API host");
  assert.ok(!/github\.com\/graphql/.test(text), "must not name the GraphQL endpoint");
});

function issueNode(number, overrides = {}) {
  return {
    number, state: "OPEN", title: `PB ${number}`, body: "## Outcome\nDo the thing.",
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

const fakeLifecycle = {
  async ready() { return { ok: true }; },
  async inspect() {
    return { ok: true, comments: [{ body: `<!-- review:v1 issue=13 -->\n- Tested commit: \`${SHA}\`\n` }] };
  },
  async complete() { return { ok: true }; },
  async block() { return { ok: true }; },
};

test("dry-run scans and selects without launching a model or writing", async () => {
  const gate = { read: async () => ({ ok: true, data: { repository: { i13: issueNode(13), i14: issueNode(14) } } }) };
  const calls = { run: 0, http: 0 };
  const batch = createBatch({
    config, gate, lifecycle: fakeLifecycle,
    run: async () => { calls.run += 1; return { status: 0, stdout: "", stderr: "" }; },
    http: async () => { calls.http += 1; return { ok: true, status: 200, json: {} }; },
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-")),
  });
  const issues = await batch.scanIssues([13, 14]);
  const plan = await batch.dryRun(issues);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.selected.map((i) => i.number), [13, 14]);
  assert.equal(calls.run, 0, "dry-run must not launch a model");
  assert.equal(calls.http, 0, "dry-run must not call the provider");
});

test("the worker gets the key in its environment only; Sol gets no deepseek and no key", async () => {
  const key = "sk-test-1234567890";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-key-"));
  const keyPath = path.join(tmp, "key");
  fs.writeFileSync(keyPath, `${key}\n`);

  const invocations = [];
  let balanceCalls = 0;
  const run = async (command, args, opts) => {
    invocations.push({ command, args, env: opts.env ?? {}, input: opts.input ?? "", cwd: opts.cwd });
    if (command === "git" && args.includes("rev-parse")) return { status: 0, stdout: "/repo\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const http = async () => {
    balanceCalls += 1;
    const total = balanceCalls === 1 ? "10.00" : "9.40";
    return { ok: true, status: 200, json: { balance_infos: [{ currency: "USD", total_balance: total }] } };
  };
  const gate = {
    async rest({ method, path: p }) {
      if (method === "GET" && p.includes("/pulls")) return { ok: true, data: [{ number: 7, head: { sha: SHA } }] };
      if (method === "POST" && p.endsWith("/pulls")) return { ok: true, data: { number: 7, html_url: "https://x/7" } };
      if (method === "PUT" && p.includes("/merge")) return { ok: true, data: { merged: true } };
      throw new Error(`unexpected rest ${method} ${p}`);
    },
  };
  const batch = createBatch({ config, gate, lifecycle: fakeLifecycle, run, http, stateDir: tmp, keyPath });
  const state = { startedAt: new Date().toISOString(), issues: {} };
  const ticket = { number: 13, title: "PB 13", body: "## Outcome\nDo the thing.", state: "OPEN", status: "Ready", acceptance: "Automated", priority: "P1", labels: ["model:standard", "effort:high"], liveClaim: null, kind: "implementation" };
  const result = await batch.runTicket(ticket, state, { externalAuthorized: new Set() });
  assert.equal(result.completed, true, JSON.stringify(result));

  const worker = invocations.find((i) => i.command === "codex" && i.args.includes("deepseek"));
  const sol = invocations.find((i) => i.command === "codex" && i.args.includes("gpt-6.1-sol"));
  assert.ok(worker, "a DeepSeek worker was launched");
  assert.ok(sol, "a Sol reviewer was launched");
  assert.deepEqual(worker.args.slice(0, 5), ["exec", "-p", "deepseek", "--model", "deepseek-v4-pro"]);
  assert.ok(worker.args.includes("-c") && worker.args.includes("approval_policy=never"), "worker must be launched approval-policy never");
  assert.ok(worker.args.includes("--add-dir"), "worker must get the git shared dir writable");
  assert.ok(worker.args.includes("--json"));
  assert.equal(worker.env.DEEPSEEK_API_KEY, key);
  assert.ok(!worker.input.includes(key), "the key must never appear in the worker prompt");
  assert.deepEqual(sol.args, ["exec", "--model", "gpt-6.1-sol", "--json"]);
  assert.equal(sol.env.DEEPSEEK_API_KEY, undefined, "Sol must not receive the DeepSeek key");
  for (const invocation of invocations) assert.ok(!invocation.input.includes(key), "no prompt or input may carry the key");
});

test("an increased balance after a worker session stops further spending", async () => {
  const key = "sk-test-1234567890";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "batch-inc-"));
  fs.writeFileSync(path.join(tmp, "key"), key);
  const launched = [];
  let calls = 0;
  const run = async (command, args, opts) => {
    if (command === "git" && args.includes("rev-parse")) return { status: 0, stdout: "/repo\n", stderr: "" };
    launched.push(command);
    return { status: 0, stdout: "", stderr: "" };
  };
  const http = async () => {
    calls += 1;
    return { ok: true, status: 200, json: { balance_infos: [{ currency: "USD", total_balance: calls === 1 ? "10.00" : "11.00" }] } };
  };
  const gate = { rest: async () => ({ ok: true, data: [] }) };
  const batch = createBatch({ config, gate, lifecycle: fakeLifecycle, run, http, stateDir: tmp, keyPath: path.join(tmp, "key") });
  const ticket = { number: 13, title: "PB 13", body: "x", state: "OPEN", status: "Ready", acceptance: "Automated", priority: "P1", labels: ["model:standard", "effort:high"], liveClaim: null, kind: "implementation" };
  const result = await batch.runTicket(ticket, { startedAt: new Date().toISOString(), issues: {} }, { externalAuthorized: new Set() });
  assert.equal(result.stopped, true);
  assert.match(result.reason, /increased/);
  assert.equal(launched.filter((c) => c === "codex").length, 1, "one worker may still have run before the increase was seen");
});
