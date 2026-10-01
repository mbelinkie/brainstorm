import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createBatchPlanner, parseCommand, runCli } from "../tools/codex-batch.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../docs/roadmap/config.json", import.meta.url), "utf8"));
const SHA = "cd15757cd7ffa0adadb91325a9613d99c9975f2d";

function contract({ migration = "None", owner = "None", scope = "Implement the bounded issue behavior.", acceptance = "Automated" } = {}) {
  return `## Outcome
The requested behavior is implemented.
## Scope
${scope}
## Exclusions
No unrelated changes.
## Dependencies
None
## Acceptance
${acceptance}
- [ ] Focused regression coverage passes.
## Verification
1. Run npm test.
## Boundaries and authorization
Contract/fixture changes: None.
External inputs/services: None.
Migrations: ${migration}
Owner decisions: ${owner}
## Starting baseline
main
## Routing and size rationale
model:standard / effort:high / Medium.`;
}

function makeWorld(overrides = {}) {
  const nodes = new Map();
  const readyCalls = [];
  let reads = 0;
  let mutations = 0;

  for (let number = 13; number <= 44; number += 1) {
    const itemId = `item-${number}`;
    const value = {
      number,
      state: "OPEN",
      body: contract(),
      status: "Inbox",
      acceptance: "Automated",
      priority: "P3",
      title: `PB ${number}`,
      itemId,
      liveClaim: null,
      claimHistoryComplete: true,
      baseline: SHA,
      blockers: [],
      ...overrides[number],
    };
    nodes.set(number, value);
  }

  const gate = {
    async read() {
      reads += 1;
      const repository = {};
      for (let number = 13; number <= 44; number += 1) {
        const node = nodes.get(number);
        if (overrides.missing === number) continue;
        repository[`i${number}`] = {
          number,
          state: node.state,
          body: node.body,
          projectItems: {
            nodes: node.onProject === false ? [] : [{
              id: node.itemId,
              project: { number: config.project.number, owner: { login: config.project.owner } },
              status: { name: node.status },
              acceptance: { name: node.acceptance },
              priority: { name: node.priority },
            }],
            pageInfo: { hasNextPage: overrides.truncated === number },
          },
        };
      }
      return { ok: true, data: { repository } };
    },
    async mutate() { mutations += 1; throw new Error("planner must not mutate"); },
  };

  const lifecycle = {
    async inspect(number) {
      const node = nodes.get(number);
      const inspection = {
        ok: true,
        issue: { number, state: node.state, title: node.title },
        status: node.status,
        acceptanceClass: node.acceptance,
        boardItemId: node.onProject === false ? null : node.itemId,
        labels: node.labels ?? ["model:standard", "effort:high"],
        claims: { live: node.liveClaim ? { executionId: node.liveClaim } : null },
        claimHistoryComplete: node.claimHistoryComplete,
        baseline: { oid: node.baseline },
        blockers: node.blockers,
        routing: { profile: "standard", effort: "high" },
      };
      return overrides.incompleteComments === number
        ? { ...inspection, claimHistoryComplete: false }
        : inspection;
    },
    async ready(number, options) {
      readyCalls.push({ number, options });
      const node = nodes.get(number);
      return node.readyResult ?? { ok: true, op: "ready", dryRun: true, wouldSet: "Ready", changed: node.status !== "Ready", status: node.status };
    },
  };

  return { gate, lifecycle, nodes, readyCalls, get reads() { return reads; }, get mutations() { return mutations; } };
}

function ready(world, number, values = {}) {
  const node = world.nodes.get(number);
  Object.assign(node, { status: "Ready", priority: "P1", ...values });
  if (!Object.hasOwn(values, "body")) {
    node.body = contract({
      migration: values.migration ?? "None",
      owner: values.owner ?? "None",
      scope: values.scope ?? "Implement the bounded issue behavior.",
      acceptance: values.acceptance ?? node.acceptance,
    });
  }
  return node;
}

test("the planner scans #13–44 and selects the highest-priority ticket after owner and migration gates", async () => {
  const world = makeWorld();
  ready(world, 13, { priority: "P0", owner: "Pending: confirm pricing" });
  ready(world, 15, { priority: "P0", owner: "Pending: confirm proxy URL source" });
  ready(world, 17, { priority: "P0", owner: "Pending: approve fixture cap" });
  ready(world, 16, { priority: "P0", migration: "0037+ (provisional)" });
  ready(world, 42, { priority: "P1" });
  ready(world, 19, { priority: "P2", acceptance: "External" });
  ready(world, 20, { priority: "P2", acceptance: "Producer" });
  ready(world, 21, { priority: "P3", liveClaim: "held-execution" });

  const result = await createBatchPlanner({ config, ...world }).plan();
  assert.equal(result.selected.number, 42);
  assert.equal(result.selected.baseline, SHA);
  assert.equal(result.selected.mergeGate, "independent verification or owner acceptance");
  assert.equal(result.scanned, 32);
  assert.deepEqual(world.readyCalls.map((call) => call.number), [42, 20]);
  assert.ok(world.readyCalls.every((call) => call.options.dryRun === true));
  assert.equal(world.reads, 1);
  assert.equal(world.mutations, 0);
  assert.ok(result.skipped.some((entry) => entry.number === 13 && entry.code === "OWNER_DECISION_PENDING"));
  assert.ok(result.skipped.some((entry) => entry.number === 16 && entry.code === "MIGRATION_ASSIGNMENT_REQUIRED"));
  assert.ok(result.skipped.some((entry) => entry.number === 19 && entry.code === "EXTERNAL_ACCEPTANCE"));
  assert.ok(result.skipped.some((entry) => entry.number === 21 && entry.code === "CLAIM_HELD"));
});

test("Producer work may be selected but carries an owner-acceptance merge gate", async () => {
  const world = makeWorld();
  ready(world, 22, { acceptance: "Producer", priority: "P0" });
  const result = await createBatchPlanner({ config, ...world }).plan();
  assert.equal(result.selected.number, 22);
  assert.equal(result.selected.mergeGate, "owner acceptance after review");
});

test("an empty Ready selection reports eligible Backlog promotions without changing status", async () => {
  const world = makeWorld();
  Object.assign(world.nodes.get(28), { status: "Backlog", priority: "P1" });
  const result = await createBatchPlanner({ config, ...world }).plan();
  assert.equal(result.selected, null);
  assert.deepEqual(result.promotionCandidates.map((candidate) => candidate.number), [28]);
  assert.equal(result.promotionCandidates[0].status, "Backlog");
  assert.deepEqual(world.readyCalls, [{ number: 28, options: { dryRun: true } }]);
  assert.equal(world.mutations, 0);
});

test("Ready dependencies are checked with lifecycle ready dry-run and blocked candidates are skipped", async () => {
  const world = makeWorld();
  ready(world, 13, { priority: "P0", readyResult: { ok: false, code: "NOT_READY", blockers: [{ code: "PREREQ_NOT_DONE" }] } });
  ready(world, 14, { priority: "P1" });
  const result = await createBatchPlanner({ config, ...world }).plan();
  assert.equal(result.selected.number, 14);
  assert.deepEqual(world.readyCalls.map((call) => [call.number, call.options]), [
    [13, { dryRun: true }],
    [14, { dryRun: true }],
  ]);
  assert.ok(result.skipped.some((entry) => entry.number === 13 && entry.code === "NOT_READY"));
});

test("missing issues, truncated Project pagination, and incomplete comments fail the scan", async (t) => {
  const cases = [
    ["missing issue", { missing: 20 }, /issue #20 is missing/],
    ["truncated Project items", { truncated: 20 }, /incomplete Project item pagination/],
    ["incomplete claim comments", { incompleteComments: 20 }, /comment history is incomplete/],
  ];
  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      const world = makeWorld(overrides);
      await assert.rejects(createBatchPlanner({ config, ...world }).plan(), expected);
      assert.equal(world.mutations, 0);
    });
  }
});

test("unknown scope or authorization skips that ticket and preserves unrelated Ready work", async () => {
  const world = makeWorld();
  ready(world, 20, { priority: "P0", body: contract({ scope: "Included work, affected modules, and required outputs." }) });
  ready(world, 21, { priority: "P1", body: contract().replace("Owner decisions: None\n", "") });
  ready(world, 22, { priority: "P2" });
  const result = await createBatchPlanner({ config, ...world }).plan();
  assert.equal(result.selected.number, 22);
  assert.ok(result.skipped.some((entry) => entry.number === 20 && entry.code === "SCOPE_UNKNOWN"));
  assert.ok(result.skipped.some((entry) => entry.number === 21 && entry.code === "AUTHORIZATION_UNKNOWN"));
  assert.deepEqual(world.readyCalls.map((call) => call.number), [22]);
});

test("an abbreviated baseline cannot be selected", async () => {
  const world = makeWorld();
  ready(world, 13, { baseline: "cd15757" });
  const result = await createBatchPlanner({ config, ...world }).plan();
  assert.equal(result.selected, null);
  assert.ok(result.skipped.some((entry) => entry.number === 13 && entry.code === "BASELINE_SHA_UNKNOWN"));
});

test("legacy execution, resume, and scope flags are rejected before constructing GitHub access", async () => {
  for (const args of [["--sole-dispatcher"], ["--resume"], ["--issues", "13..44"], ["--resume=true"]]) {
    assert.throws(() => parseCommand(args), { code: "LEGACY_FLAG_DISABLED" });
  }
  assert.equal(parseCommand(["--dry-run"]), "dry-run");
  assert.equal(parseCommand(["--help"]), "help");

  let contexts = 0;
  const errors = [];
  const status = await runCli(["--sole-dispatcher"], {
    makeContext() { contexts += 1; throw new Error("must not initialize a transport"); },
    error: (message) => errors.push(message),
  });
  assert.equal(status, 2);
  assert.equal(contexts, 0);
  assert.match(errors[0], /LEGACY_FLAG_DISABLED/);
});

test("the tool source has only planner/help behavior and uses gate plus lifecycle", () => {
  const source = fs.readFileSync(new URL("../tools/codex-batch.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/scripts\/roadmap\/gate\.mjs"/);
  assert.match(source, /lifecycle\.inspect\(number\)/);
  assert.match(source, /lifecycle\.ready\(issue\.number, \{ dryRun: true \}\)/);
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|DEEPSEEK|gate\.(?:mutate|rest)/i);
  assert.doesNotMatch(source, /api\.github\.com|github\.com\/graphql/);
});
