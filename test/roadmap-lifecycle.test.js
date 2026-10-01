import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createGate } from "../scripts/roadmap/gate.mjs";
import { createBudget } from "../scripts/roadmap/rate-limit.mjs";
import { createLifecycle } from "../scripts/roadmap/lifecycle.mjs";
import {
  effectiveEffort,
  PLACEHOLDER_LINES,
  normalizeLine,
  evaluateRouting,
  parseClaims,
  parseContract,
  parseDependencies,
  resolveExecutionId,
  resolveOwnExecutionId,
} from "../scripts/roadmap/lifecycle-core.mjs";

// The lifecycle wrapper (issue #3) is exercised ONLY against a fake GitHub
// transport behind the real gate, with a fake clock. Nothing here calls GitHub.
// Every refusal test also asserts that no write was sent, because "refuses
// before any write" is the contract.

const root = new URL("../", import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL("docs/roadmap/config.json", root), "utf8"));
const T0 = Date.parse("2026-10-01T00:00:00Z");
const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PARENT = "33333333-3333-4333-8333-333333333333";
const BASE_OID = "eace95015de0456d751fc7b83c686aa09395e7ea";
const STATUS_OPTIONS = config.fields.Status.options;
const STATUS_NAME = Object.fromEntries(Object.entries(STATUS_OPTIONS).map(([name, id]) => [id, name]));

// ---- fixtures -------------------------------------------------------------

function contractBody({ deps = "Blocked by #4", acceptance = "Automated", drop = [], extra = {} } = {}) {
  const sections = {
    Outcome: "A tested wrapper enforces the front half of the lifecycle.",
    Scope: "- CLI plus tests.",
    Exclusions: "- review and complete are #45.",
    Dependencies: deps,
    Acceptance: `${acceptance}\n- [ ] Fake-gate tests prove the refusals.`,
    Verification: "1. `npm test`; paste the output.",
    "Boundaries and authorization": "Contract/fixture changes: additive routing block.\nMigrations: None.",
    "Starting baseline": "`main`, with #4 merged.",
    "Routing and size rationale": "`model:standard` / `effort:high` / Large.",
    ...extra,
  };
  return Object.entries(sections)
    .filter(([name]) => !drop.includes(name))
    .map(([name, text]) => `## ${name}\n${text}`)
    .join("\n\n");
}

const doneItem = { id: "PVTI_done", projectNumber: 4, owner: "mbelinkie", status: "Done" };
const completeComment = (n) => ({ id: `C_done_${n}`, body: `<!-- complete:v1 issue=${n} -->\n**Accepted and completed.**`, createdAt: "2026-10-01T04:03:09Z" });

function makeWorld(mutate = {}) {
  const world = {
    repo: "mbelinkie/brainstorm",
    issues: {
      3: {
        id: "I_3", number: 3, state: "OPEN", title: "Lifecycle wrapper", body: contractBody(),
        labels: ["model:standard", "effort:high"],
        blockedBy: [{ number: 4, repo: "mbelinkie/brainstorm" }],
        comments: [],
        items: [{ id: "PVTI_3", projectNumber: 4, owner: "mbelinkie", status: "Backlog", acceptance: "Automated" }],
      },
      4: {
        id: "I_4", number: 4, state: "CLOSED", title: "Gate", body: "x", labels: [], blockedBy: [],
        comments: [completeComment(4)], items: [{ ...doneItem }],
      },
    },
    other: {},
    addCommentMode: "ok", // ok | fail-before | land-then-500
    statusFailures: [], // queued HTTP statuses for the next SetStatus calls
    nextComment: 1,
    ...mutate,
  };
  return world;
}

const rl = (remaining = 4000) => ({ limit: 5000, remaining, used: 5000 - remaining, resetAt: new Date(T0 + 3_600_000).toISOString(), cost: 1 });
const gqlOk = (data) => ({ status: 200, headers: {}, body: { data: { ...data, rateLimit: rl() } } });
const mutOk = (data) => ({
  status: 200,
  headers: {
    "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "3990", "x-ratelimit-used": "1010",
    "x-ratelimit-reset": String((T0 + 3_600_000) / 1000), "x-ratelimit-resource": "graphql",
  },
  body: { data },
});
const itemNodes = (issue) => issue.items.map((item) => ({
  id: item.id,
  project: { id: config.project.nodeId, number: item.projectNumber, owner: { login: item.owner } },
  status: item.status ? { name: item.status } : null,
  acceptance: item.acceptance ? { name: item.acceptance } : null,
}));

function issueNode(issue, world) {
  return {
    id: issue.id, number: issue.number, state: issue.state, title: issue.title, body: issue.body,
    labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo: { hasNextPage: Boolean(world.labelsTruncated) } },
    blockedBy: {
      nodes: issue.blockedBy.map((b) => ({ number: b.number, state: "OPEN", repository: { nameWithOwner: b.repo } })),
      pageInfo: { hasNextPage: false },
    },
    comments: { nodes: issue.comments.map((c) => ({ ...c, author: c.author ?? { login: "mbelinkie" } })), pageInfo: { hasPreviousPage: Boolean(world.commentsTruncated), hasNextPage: false } },
    projectItems: { nodes: itemNodes(issue), pageInfo: { hasNextPage: false } },
  };
}

function lookup(world, repo, number) {
  if (repo === world.repo) return world.issues[number];
  return world.other[`${repo}#${number}`];
}

// Fake GitHub. Recognises the wrapper's named operations.
function makeTransport(world) {
  const calls = [];
  const mutations = () => calls.filter((c) => /\bmutation\b/.test(c.query ?? "") && !/RoadmapRateLimit/.test(c.query));
  return {
    calls,
    mutations,
    mutationNames: () => mutations().map((m) => /mutation\s+(\w+)/.exec(m.query)[1]),
    async request(request) {
      calls.push(request);
      const q = request.query ?? "";
      if (/RoadmapRateLimit/.test(q)) return gqlOk({});
      if (/query LifecycleIssue\b/.test(q)) {
        const { owner, name, number } = request.variables;
        const issue = lookup(world, `${owner}/${name}`, number);
        return gqlOk({
          repository: { nameWithOwner: world.repo, ref: { target: { oid: BASE_OID } }, issue: issue ? issueNode(issue, world) : null },
        });
      }
      if (/query LifecyclePrereqs\b/.test(q)) {
        const data = {};
        for (const m of q.matchAll(/(d\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ issue\(number: (\d+)\)/g)) {
          const issue = lookup(world, `${m[2]}/${m[3]}`, Number(m[4]));
          data[m[1]] = {
            issue: issue ? {
              number: issue.number, state: issue.state,
              projectItems: { nodes: itemNodes(issue), pageInfo: { hasNextPage: false } },
              comments: { nodes: issue.comments.map((c) => ({ ...c, author: c.author ?? { login: "mbelinkie" } })), pageInfo: { hasPreviousPage: Boolean(world.prereqCommentsTruncated), hasNextPage: false } },
            } : null,
          };
        }
        return gqlOk(data);
      }
      if (/mutation LifecycleAddComment\b/.test(q)) {
        if (world.addCommentMode === "fail-before") return { status: 502, headers: {}, body: null };
        const issue = Object.values(world.issues).find((i) => i.id === request.variables.id);
        const comment = { id: `C_${world.nextComment}`, body: request.variables.body, createdAt: new Date(T0).toISOString() };
        world.nextComment += 1;
        issue.comments.push(comment);
        if (world.addCommentMode === "land-then-500") return { status: 502, headers: {}, body: null };
        return mutOk({ addComment: { commentEdge: { node: { id: comment.id, url: `https://example.test/${comment.id}` } } } });
      }
      if (/mutation LifecycleSetStatus\b/.test(q)) {
        const failure = world.statusFailures.shift();
        if (failure) return { status: failure, headers: {}, body: null };
        const { item, option } = request.variables;
        for (const issue of Object.values(world.issues)) {
          for (const it of issue.items) if (it.id === item) it.status = STATUS_NAME[option];
        }
        return mutOk({ updateProjectV2ItemFieldValue: { projectV2Item: { id: item } } });
      }
      throw new Error(`fake transport: unexpected request ${q.slice(0, 80)}`);
    },
  };
}

function setup({ world = makeWorld(), env = { CLAUDE_CODE_SESSION_ID: SELF }, lock, limits } = {}) {
  const transport = makeTransport(world);
  let t = T0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const lockCalls = { acquired: 0, released: 0 };
  const defaultLock = { acquire: () => { lockCalls.acquired += 1; return { ok: true, release() { lockCalls.released += 1; } }; } };
  const gate = createGate({ transport, budget: createBudget({ now }), lock: lock ?? defaultLock, now, sleep, limits });
  const lifecycle = createLifecycle({ gate, config, env, now });
  return { world, transport, gate, lifecycle, lockCalls, now };
}

const claimOpts = (extra = {}) => ({
  executionId: SELF,
  branch: "codex/lifecycle-wrapper-1",
  startCommit: BASE_OID,
  model: "deepseek-v4-pro",
  effort: "high",
  worktree: "../quiz-lifecycle",
  ...extra,
});

const readyWorld = (mutate) => {
  const world = makeWorld(mutate);
  world.issues[3].items[0].status = "Ready";
  return world;
};

const claimComment = (executionId = OTHER, n = 3) => ({
  id: "C_old", createdAt: "2026-10-01T03:00:00Z",
  body: `<!-- claim:v1 issue=${n} -->\n**Claim**\n\n- Repository / issue: mbelinkie/brainstorm #${n}\n- Execution ID: Claude Code session \`${executionId}\`\n- Owner: mbelinkie\n`,
});

function assertNoWrites(transport) {
  assert.deepEqual(transport.mutationNames(), [], "a write was sent before/despite the refusal");
}

function blockerCodes(result) {
  return (result.blockers ?? []).map((b) => b.code);
}

// ---- parsing (pure) -------------------------------------------------------

test("the config routing block mirrors docs/roadmap/routing.md", () => {
  const md = fs.readFileSync(new URL("docs/roadmap/routing.md", root), "utf8");
  for (const [name, profile] of Object.entries(config.routing.profiles)) {
    assert.ok(md.includes(`\`model:${name}\``), `routing.md names model:${name}`);
    assert.ok(md.includes(profile.modelId), `routing.md names ${profile.modelId}`);
  }
  assert.ok(!md.includes("model:advanced"), "no advanced profile exists");
  for (const effort of config.routing.efforts) assert.ok(md.includes(`\`effort:${effort}\``));
  for (const [logical, effective] of Object.entries(config.routing.effectiveEfforts)) {
    assert.ok(md.includes(`| \`${logical}\` | \`${effective}\` |`), `routing.md maps ${logical} -> ${effective}`);
  }
  assert.deepEqual(Object.keys(config.routing.profiles).sort(), ["coordinator", "economy", "standard"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.routing.profiles).map(([name, profile]) => [name, profile.model])),
    { coordinator: "Sol coordinator (not implementation)", economy: "DeepSeek Flash", standard: "DeepSeek Pro" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.routing.profiles).map(([name, profile]) => [name, profile.modelId])),
    { coordinator: "gpt-6.1-sol", economy: "deepseek-flash", standard: "deepseek-v4-pro" },
  );
});

test("config.json only gained the routing block; no id or field changed", () => {
  assert.deepEqual(Object.keys(config), ["_comment", "repository", "project", "documents", "fields", "crossRepoPrerequisites", "routing"]);
  assert.equal(config.project.nodeId, "PVT_kwHOEuIric4BlRrA");
  assert.equal(config.fields.Status.options.Ready, "98b33298");
});

test("parseDependencies accepts the canonical forms and nothing else", () => {
  assert.deepEqual(parseDependencies("Blocked by #4", "a/b"), { ok: true, refs: ["a/b#4"] });
  assert.deepEqual(parseDependencies("Blocked by #4\nBlocked by x/y#7\n", "a/b"), { ok: true, refs: ["a/b#4", "x/y#7"] });
  assert.deepEqual(parseDependencies("None", "a/b"), { ok: true, refs: [] });
  assert.equal(parseDependencies("Blocked by #4 (and later #5)", "a/b").ok, false, "prose is not machine-readable");
  assert.equal(parseDependencies("None\nBlocked by #4", "a/b").ok, false, "None plus an entry is contradictory");
  assert.equal(parseDependencies("", "a/b").ok, false);
});

test("parseContract flags missing sections, empty sections and every template placeholder", () => {
  assert.deepEqual(parseContract(contractBody()).problems, []);
  const missing = parseContract(contractBody({ drop: ["Verification"] }));
  assert.deepEqual(missing.problems.map((p) => p.code), ["CONTRACT_SECTION_MISSING"]);
  const empty = parseContract(contractBody({ extra: { Scope: "   " } }));
  assert.deepEqual(empty.problems.map((p) => p.code), ["CONTRACT_SECTION_MISSING"]);
  const tbd = parseContract(contractBody({ extra: { Outcome: "TBD" } }));
  assert.deepEqual(tbd.problems.map((p) => p.code), ["CONTRACT_PLACEHOLDER"]);
});

test("the placeholder list covers every body line of the real issue template", () => {
  const template = fs.readFileSync(new URL(".github/ISSUE_TEMPLATE/work-contract.md", root), "utf8");
  const lines = template
    .replace(/^---[\s\S]*?---/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("## "));
  const uncovered = lines.filter((line) => !PLACEHOLDER_LINES.includes(normalizeLine(line)));
  assert.deepEqual(uncovered, [], "template lines the placeholder check would miss");
  // and the whole unedited template is refused
  const body = template.replace(/^---[\s\S]*?---/, "");
  const codes = parseContract(body).problems.map((p) => p.code);
  assert.ok(codes.includes("CONTRACT_PLACEHOLDER"));
});

test("evaluateRouting enforces exactly one model, one effort and a supported pairing", () => {
  const ok = evaluateRouting(["model:standard", "effort:high", "bug"], config.routing);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.profile, "standard");
  assert.equal(ok.effort, "high");
  const codes = (labels) => evaluateRouting(labels, config.routing).problems.map((p) => p.code);
  assert.deepEqual(codes(["effort:high"]), ["MODEL_LABEL_COUNT"]);
  assert.deepEqual(codes(["model:standard", "model:economy", "effort:low"]), ["MODEL_LABEL_COUNT"]);
  assert.deepEqual(codes(["model:standard"]), ["EFFORT_LABEL_COUNT"]);
  assert.deepEqual(codes(["model:standard", "effort:low", "effort:high"]), ["EFFORT_LABEL_COUNT"]);
  assert.deepEqual(codes(["model:advanced", "effort:low"]), ["MODEL_LABEL_UNKNOWN"]);
  assert.deepEqual(codes(["model:standard", "effort:extreme"]), ["EFFORT_LABEL_UNKNOWN"]);
  assert.deepEqual(codes(["model:economy", "effort:high"]), [], "both profiles support every logical effort");
  // escalation:opus is retired history; it never changes or replaces the model label
  assert.deepEqual(codes(["model:standard", "effort:high", "escalation:opus"]), []);
  assert.deepEqual(codes(["escalation:opus", "effort:high"]), ["MODEL_LABEL_COUNT"]);
});

test("effectiveEffort follows the configured runner mapping", () => {
  assert.equal(effectiveEffort("low", config.routing), "low");
  assert.equal(effectiveEffort("medium", config.routing), "high");
  assert.equal(effectiveEffort("high", config.routing), "high");
  assert.equal(effectiveEffort("extreme", config.routing), null);
});

test("parseClaims reads the claims already on #12 and #4, and ends a claim on a complete marker", () => {
  const real4 = {
    id: "C1", createdAt: "2026-10-01T03:50:40Z",
    body: "<!-- claim:v1 issue=4 -->\n**Claim** (manual)\n\n- Repository / issue: mbelinkie/brainstorm #4\n- Execution ID: Claude Code session `8d152cba-140a-4895-b978-90f535988cdf`. The same session also holds the claim on #12\n- Owner: mbelinkie (driving); executed by Claude\n",
  };
  const parsed = parseClaims([real4], 4);
  assert.equal(parsed.claims.length, 1);
  assert.equal(parsed.claims[0].executionId, "8d152cba-140a-4895-b978-90f535988cdf");
  assert.equal(parsed.live?.executionId, "8d152cba-140a-4895-b978-90f535988cdf");
  const ended = parseClaims([real4, { id: "C2", body: "<!-- complete:v1 issue=4 -->\nAccepted", createdAt: "x" }], 4);
  assert.equal(ended.live, null);
  const other = parseClaims([real4], 5);
  assert.equal(other.claims.length, 0, "a claim marker for another issue is not this issue's claim");
  const unreadable = parseClaims([{ id: "C3", body: "<!-- claim:v1 issue=4 -->\nno id here", createdAt: "x" }], 4);
  assert.equal(unreadable.live?.executionId, null, "a claim with no readable execution ID still counts as live");
});

test("parseClaims keeps retired Claude and DeepSeek model claims readable", () => {
  const comments = ["claude-sonnet-5-5", "deepseek-v4-pro", "deepseek-flash"].map((model, index) => ({
    id: `C_legacy_${index}`,
    body: `<!-- claim:v1 issue=51 -->\n- Execution ID: \`${OTHER}\`\n- Model / effort: \`${model}\` / effort \`high\``,
  }));
  assert.equal(parseClaims(comments, 51).live.executionId, OTHER);
});

// ---- execution id ---------------------------------------------------------

test("resolveExecutionId accepts only an explicit id that matches this run's own env value", () => {
  assert.deepEqual(resolveExecutionId({ flag: SELF, env: { CLAUDE_CODE_SESSION_ID: SELF } }), { ok: true, executionId: SELF });
  const code = (args) => resolveExecutionId(args).code;
  assert.equal(code({ flag: undefined, env: { CLAUDE_CODE_SESSION_ID: SELF } }), "EXECUTION_ID_MISSING", "must be stated, not guessed");
  assert.equal(code({ flag: SELF, env: {} }), "EXECUTION_ID_MISSING");
  assert.equal(code({ flag: "", env: { CLAUDE_CODE_SESSION_ID: SELF } }), "EXECUTION_ID_MISSING");
  assert.equal(code({ flag: SELF, env: { CLAUDE_CODE_SESSION_ID: OTHER } }), "EXECUTION_ID_CONFLICT");
  assert.equal(code({ flag: ["a", "b"], env: { CLAUDE_CODE_SESSION_ID: SELF } }), "EXECUTION_ID_CONFLICT", "duplicated flag");
  assert.equal(code({ flag: "not-a-uuid", env: { CLAUDE_CODE_SESSION_ID: "not-a-uuid" } }), "EXECUTION_ID_INVALID");
  assert.equal(code({ flag: SELF, env: { CLAUDE_CODE_SESSION_ID: SELF, CLAUDE_CODE_PARENT_SESSION_ID: SELF } }), "EXECUTION_ID_INHERITED");
  assert.equal(code({ flag: SELF, env: { CLAUDE_CODE_SESSION_ID: SELF, CLAUDE_CODE_PARENT_SESSION_ID: PARENT } }), undefined, "a different parent id is fine");
});

test("resolveOwnExecutionId accepts a genuine Codex thread id and validates a matching session id", () => {
  assert.deepEqual(resolveOwnExecutionId({ CODEX_THREAD_ID: SELF }), { ok: true, executionId: SELF });
  assert.deepEqual(resolveOwnExecutionId({ CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: SELF }), { ok: true, executionId: SELF });
  assert.deepEqual(resolveOwnExecutionId({ CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: SELF, CLAUDE_CODE_SESSION_ID: SELF }), { ok: true, executionId: SELF });
  assert.deepEqual(resolveOwnExecutionId({ CLAUDE_CODE_SESSION_ID: SELF }), { ok: true, executionId: SELF });
});

test("conflicting or ambiguous Codex environments fail closed", () => {
  const code = (env) => resolveOwnExecutionId(env).code;
  assert.equal(code({}), "EXECUTION_ID_MISSING");
  assert.equal(code({ CODEX_SESSION_ID: SELF }), "EXECUTION_ID_AMBIGUOUS", "a session id without the thread id cannot be validated");
  assert.equal(code({ CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: OTHER }), "EXECUTION_ID_AMBIGUOUS", "session != thread");
  assert.equal(code({ CODEX_THREAD_ID: SELF, CLAUDE_CODE_SESSION_ID: OTHER }), "EXECUTION_ID_AMBIGUOUS", "a legacy Claude id that disagrees with Codex");
  assert.equal(code({ CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: SELF, CLAUDE_CODE_SESSION_ID: OTHER }), "EXECUTION_ID_AMBIGUOUS");
});

test("resolveExecutionId honours the Codex thread id and refuses a mismatched explicit id", () => {
  const env = { CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: SELF };
  assert.deepEqual(resolveExecutionId({ flag: SELF, env }), { ok: true, executionId: SELF });
  assert.equal(resolveExecutionId({ flag: OTHER, env }).code, "EXECUTION_ID_CONFLICT");
  assert.equal(resolveExecutionId({ flag: SELF, env: { CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: OTHER } }).code, "EXECUTION_ID_AMBIGUOUS");
  assert.equal(resolveExecutionId({ flag: SELF, env: { CODEX_THREAD_ID: SELF, CLAUDE_CODE_PARENT_SESSION_ID: SELF } }).code, "EXECUTION_ID_INHERITED");
  assert.equal(resolveExecutionId({ flag: SELF, env: { CODEX_THREAD_ID: SELF, CODEX_PARENT_THREAD_ID: SELF } }).code, "EXECUTION_ID_INHERITED");
});

// ---- inspect --------------------------------------------------------------

test("inspect reads live state, reports blockers, and makes no mutating call", async () => {
  const { lifecycle, transport } = setup();
  const result = await lifecycle.inspect(3);
  assert.equal(result.ok, true);
  assert.equal(result.issue.number, 3);
  assert.equal(result.status, "Backlog");
  assert.deepEqual(result.labels, ["model:standard", "effort:high"]);
  assert.equal(result.routing.profile, "standard");
  assert.deepEqual(result.dependencies.declared, ["mbelinkie/brainstorm#4"]);
  assert.deepEqual(result.dependencies.native, ["mbelinkie/brainstorm#4"]);
  assert.equal(result.dependencies.prerequisites[0].done, true);
  assert.equal(result.baseline.oid, BASE_OID);
  assert.equal(result.claimHistoryComplete, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.readyToPromote, true);
  assert.ok(transport.calls.length >= 2);
  assertNoWrites(transport);
});

test("inspect of an unready issue still succeeds and lists why, with no write", async () => {
  const world = makeWorld();
  world.issues[3].labels = ["model:standard"];
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.inspect(3);
  assert.equal(result.ok, true);
  assert.equal(result.readyToPromote, false);
  assert.deepEqual(blockerCodes(result), ["EFFORT_LABEL_COUNT"]);
  assertNoWrites(transport);
});

test("inspect reports a live claim and an incomplete claim history", async () => {
  const world = makeWorld();
  world.issues[3].comments = [claimComment(OTHER)];
  world.commentsTruncated = true;
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.inspect(3);
  assert.equal(result.claims.live.executionId, OTHER);
  assert.equal(result.claimHistoryComplete, false);
  assertNoWrites(transport);
});

test("inspect of a missing issue is a clean refusal", async () => {
  const { lifecycle, transport } = setup();
  const result = await lifecycle.inspect(999);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ISSUE_NOT_FOUND");
  assertNoWrites(transport);
});

// ---- ready: refusals ------------------------------------------------------

async function readyRefused(mutate, expectedCodes, { world = makeWorld(), after } = {}) {
  mutate?.(world);
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.ready(3);
  assert.equal(result.ok, false, "ready must refuse");
  assert.equal(result.code, "NOT_READY");
  assert.deepEqual(blockerCodes(result).sort(), [...expectedCodes].sort());
  assertNoWrites(transport);
  assert.equal(world.issues[3].items[0].status, "Backlog", "status must be untouched");
  after?.(result);
}

test("ready refuses a missing contract section", () =>
  readyRefused((w) => { w.issues[3].body = contractBody({ drop: ["Exclusions"] }); }, ["CONTRACT_SECTION_MISSING"]));

test("ready refuses an unreplaced placeholder", () =>
  readyRefused((w) => { w.issues[3].body = contractBody({ extra: { Scope: "- Included work, affected modules, and required outputs." } }); }, ["CONTRACT_PLACEHOLDER"]));

test("ready refuses zero model labels", () =>
  readyRefused((w) => { w.issues[3].labels = ["effort:high"]; }, ["MODEL_LABEL_COUNT"]));

test("ready refuses two model labels", () =>
  readyRefused((w) => { w.issues[3].labels = ["model:standard", "model:economy", "effort:low"]; }, ["MODEL_LABEL_COUNT"]));

test("ready refuses zero effort labels", () =>
  readyRefused((w) => { w.issues[3].labels = ["model:standard"]; }, ["EFFORT_LABEL_COUNT"]));

test("ready refuses two effort labels", () =>
  readyRefused((w) => { w.issues[3].labels = ["model:standard", "effort:low", "effort:high"]; }, ["EFFORT_LABEL_COUNT"]));

test("ready accepts economy plus a high logical effort", async () => {
  const world = makeWorld();
  world.issues[3].labels = ["model:economy", "effort:high"];
  world.issues[3].items[0].status = "Backlog";
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.ready(3);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(world.issues[3].items[0].status, "Ready");
  assert.equal(transport.mutations().length, 1);
});

test("ready refuses two acceptance classes and an acceptance field that disagrees with the body", async () => {
  await readyRefused((w) => { w.issues[3].body = contractBody({ acceptance: "Automated | External" }); }, ["ACCEPTANCE_CLASS"]);
  await readyRefused((w) => { w.issues[3].items[0].acceptance = "Producer"; }, ["ACCEPTANCE_MISMATCH"]);
  await readyRefused((w) => { w.issues[3].items[0].acceptance = null; }, ["ACCEPTANCE_MISMATCH"]);
});

test("ready refuses a Dependencies section that the native blocked-by links disagree with", async () => {
  await readyRefused((w) => { w.issues[3].blockedBy = []; }, ["DEPENDENCY_MISMATCH"]);
  await readyRefused((w) => {
    w.issues[3].blockedBy.push({ number: 9, repo: "mbelinkie/brainstorm" });
    w.issues[9] = { id: "I_9", number: 9, state: "CLOSED", body: "x", labels: [], blockedBy: [], comments: [completeComment(9)], items: [{ ...doneItem, id: "PVTI_9" }] };
  }, ["DEPENDENCY_MISMATCH"]);
});

test("ready refuses Dependencies prose it cannot parse", () =>
  readyRefused((w) => {
    w.issues[3].body = contractBody({ deps: "Blocked by #4, once it lands" });
  }, ["DEPENDENCIES_UNPARSEABLE"]));

test("ready refuses a prerequisite that is closed but not Done on its roadmap", () =>
  readyRefused((w) => { w.issues[4].items[0].status = "In review"; }, ["PREREQ_NOT_DONE"]));

test("ready refuses a prerequisite that is Done but still open", () =>
  readyRefused((w) => { w.issues[4].state = "OPEN"; }, ["PREREQ_NOT_CLOSED"]));

test("ready refuses a prerequisite with no recorded acceptance, and one that is not on the board", async () => {
  await readyRefused((w) => { w.issues[4].comments = []; }, ["PREREQ_NO_ACCEPTANCE"]);
  await readyRefused((w) => { w.issues[4].items = []; }, ["PREREQ_NOT_DONE"]);
  // a Done item on some OTHER project does not count
  await readyRefused((w) => { w.issues[4].items = [{ ...doneItem, projectNumber: 7 }]; }, ["PREREQ_NOT_DONE"]);
});

test("ready refuses when a prerequisite cannot be found at all", () =>
  readyRefused((w) => { delete w.issues[4]; }, ["PREREQ_NOT_FOUND"]));

test("ready fails closed on truncated metadata, reporting it as incomplete rather than guessing", async () => {
  const world = makeWorld({ labelsTruncated: true });
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.ready(3);
  assert.equal(result.ok, false);
  assert.equal(result.code, "INCOMPLETE");
  assertNoWrites(transport);
  const world2 = makeWorld({ prereqCommentsTruncated: true });
  world2.issues[4].comments = []; // acceptance marker might be on the page we could not see
  const second = setup({ world: world2 });
  const result2 = await second.lifecycle.ready(3);
  assert.equal(result2.ok, false);
  assert.deepEqual(blockerCodes(result2), ["PREREQ_NO_ACCEPTANCE"]);
  assert.match(result2.blockers[0].message, /truncated|older/i);
  assertNoWrites(second.transport);
});

test("ready refuses a stale or cached read before any write", async () => {
  const writes = [];
  const state = makeWorld();
  const transport = makeTransport(state);
  const real = createGate({ transport, budget: createBudget({ now: () => T0 }), lock: { acquire: () => ({ ok: true, release() {} }) }, now: () => T0, sleep: async () => {} });
  const staleGate = {
    session: (task) => real.session((ops) => task({
      ...ops,
      read: async (args) => ({ ...(await ops.read(args)), fromCache: true, ageMs: 600_000 }),
      mutate: async (args) => { writes.push(args); return ops.mutate(args); },
    })),
  };
  const lifecycle = createLifecycle({ gate: staleGate, config, env: { CLAUDE_CODE_SESSION_ID: SELF }, now: () => T0 });
  const result = await lifecycle.ready(3);
  assert.equal(result.ok, false);
  assert.equal(result.code, "STALE_READ");
  assert.deepEqual(writes, []);
  assertNoWrites(transport);
});

test("ready refuses a closed issue, an issue not on the board, and statuses that must not be promoted", async () => {
  for (const status of ["Inbox", "In progress", "In review", "Done"]) {
    const world = makeWorld();
    world.issues[3].items[0].status = status;
    const { lifecycle, transport } = setup({ world });
    const result = await lifecycle.ready(3);
    assert.equal(result.ok, false, status);
    assert.equal(result.code, "STATUS_NOT_PROMOTABLE", status);
    assertNoWrites(transport);
  }
  const closed = makeWorld();
  closed.issues[3].state = "CLOSED";
  const a = setup({ world: closed });
  assert.equal((await a.lifecycle.ready(3)).code, "ISSUE_CLOSED");
  assertNoWrites(a.transport);
  const offBoard = makeWorld();
  offBoard.issues[3].items = [];
  const b = setup({ world: offBoard });
  assert.equal((await b.lifecycle.ready(3)).code, "NOT_ON_BOARD");
  assertNoWrites(b.transport);
});

// ---- ready: success -------------------------------------------------------

test("ready promotes a complete, unblocked issue: one status write, nothing else", async () => {
  const { lifecycle, transport, world, lockCalls } = setup();
  const result = await lifecycle.ready(3);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.status, "Ready");
  assert.deepEqual(transport.mutationNames(), ["LifecycleSetStatus"]);
  const vars = transport.mutations()[0].variables;
  assert.deepEqual(vars, { project: config.project.nodeId, item: "PVTI_3", field: config.fields.Status.id, option: STATUS_OPTIONS.Ready });
  assert.equal(world.issues[3].items[0].status, "Ready");
  assert.equal(lockCalls.acquired, 1, "reads and the write share one lock");
  assert.equal(lockCalls.released, 1);
});

test("ready promotes a Blocked issue once the blockers are gone, and is a no-op when already Ready", async () => {
  const world = makeWorld();
  world.issues[3].items[0].status = "Blocked";
  const a = setup({ world });
  assert.equal((await a.lifecycle.ready(3)).changed, true);
  const already = readyWorld();
  const b = setup({ world: already });
  const result = await b.lifecycle.ready(3);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assertNoWrites(b.transport);
});

test("ready --dry-run reports what it would do and writes nothing", async () => {
  const { lifecycle, transport, world } = setup();
  const result = await lifecycle.ready(3, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldSet, "Ready");
  assertNoWrites(transport);
  assert.equal(world.issues[3].items[0].status, "Backlog");
});

test("ready accepts a cross-repository prerequisite only with its authoritative Project in config", async () => {
  const build = () => {
    const world = makeWorld();
    world.issues[3].body = contractBody({ deps: "Blocked by other/lib#7" });
    world.issues[3].blockedBy = [{ number: 7, repo: "other/lib" }];
    world.other["other/lib#7"] = {
      id: "I_o7", number: 7, state: "CLOSED", body: "x", labels: [], blockedBy: [], comments: [{ ...completeComment(7), author: { login: "other" } }],
      items: [{ id: "PVTI_o7", projectNumber: 2, owner: "other", status: "Done" }],
    };
    return world;
  };
  const without = setup({ world: build() });
  const refused = await without.lifecycle.ready(3);
  assert.deepEqual(blockerCodes(refused), ["CROSS_REPO_PROJECT_UNKNOWN"]);
  assertNoWrites(without.transport);

  const cfg = { ...config, crossRepoPrerequisites: [{ repository: "other/lib", project: { owner: "other", number: 2 } }] };
  const world = build();
  const transport = makeTransport(world);
  const gate = createGate({ transport, budget: createBudget({ now: () => T0 }), lock: { acquire: () => ({ ok: true, release() {} }) }, now: () => T0, sleep: async () => {} });
  const lifecycle = createLifecycle({ gate, config: cfg, env: {}, now: () => T0 });
  const result = await lifecycle.ready(3);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
});

// ---- claim: refusals before any write ------------------------------------

test("claim refuses a missing, conflicting, malformed or inherited execution ID before touching GitHub", async () => {
  const cases = [
    [{ executionId: undefined }, {}, "EXECUTION_ID_MISSING"],
    [{ executionId: SELF }, { env: {} }, "EXECUTION_ID_MISSING"],
    [{ executionId: SELF }, { env: { CLAUDE_CODE_SESSION_ID: OTHER } }, "EXECUTION_ID_CONFLICT"],
    [{ executionId: [SELF, OTHER] }, {}, "EXECUTION_ID_CONFLICT"],
    [{ executionId: "abc" }, { env: { CLAUDE_CODE_SESSION_ID: "abc" } }, "EXECUTION_ID_INVALID"],
    [{ executionId: SELF }, { env: { CLAUDE_CODE_SESSION_ID: SELF, CLAUDE_CODE_PARENT_SESSION_ID: SELF } }, "EXECUTION_ID_INHERITED"],
  ];
  for (const [opts, envOverride, code] of cases) {
    const { lifecycle, transport, lockCalls } = setup({ world: readyWorld(), ...envOverride });
    const result = await lifecycle.claim(3, claimOpts(opts));
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assert.equal(transport.calls.length, 0, `${code}: no request of any kind may be sent`);
    assert.equal(lockCalls.acquired, 0, `${code}: lock not even taken`);
  }
});

test("claim refuses bad branch, commit or model facts before touching GitHub", async () => {
  const cases = [
    [{ branch: "main" }, "BRANCH_INVALID"],
    [{ branch: "" }, "BRANCH_INVALID"],
    [{ startCommit: "nothex" }, "START_COMMIT_INVALID"],
    [{ startCommit: undefined }, "START_COMMIT_INVALID"],
    [{ model: "" }, "MODEL_MISSING"],
    [{ effort: "extreme" }, "EFFORT_INVALID"],
  ];
  for (const [extra, code] of cases) {
    const { lifecycle, transport } = setup({ world: readyWorld() });
    const result = await lifecycle.claim(3, claimOpts(extra));
    assert.equal(result.code, code);
    assert.equal(transport.calls.length, 0, code);
  }
});

test("claim refuses an absolute local worktree path (public repo) before touching GitHub", async () => {
  const { lifecycle, transport } = setup({ world: readyWorld() });
  const result = await lifecycle.claim(3, claimOpts({ worktree: "C:/Users/someone/quiz" }));
  assert.equal(result.code, "WORKTREE_PATH_PRIVATE");
  assert.equal(transport.calls.length, 0);
});

test("only the owner can end a claim or supply a prerequisite's acceptance record", async () => {
  const forged = { id: "C_f", createdAt: "x", author: { login: "stranger" }, body: "<!-- complete:v1 issue=3 -->\nAccepted" };
  const world = readyWorld();
  world.issues[3].comments = [claimComment(OTHER), forged];
  const { lifecycle, transport } = setup({ world });
  assert.equal((await lifecycle.claim(3, claimOpts())).code, "CLAIM_HELD", "a stranger's complete marker must not release the claim");
  assertNoWrites(transport);
  const w2 = makeWorld();
  w2.issues[4].comments = [{ ...completeComment(4), author: { login: "stranger" } }];
  const b = setup({ world: w2 });
  assert.deepEqual(blockerCodes(await b.lifecycle.ready(3)), ["PREREQ_NO_ACCEPTANCE"]);
  assertNoWrites(b.transport);
});

test("claim refuses a lock held by a live owner without any network call or write", async () => {
  const held = { acquire: () => ({ ok: false, code: "LOCK_CONTENDED", message: "held by a live process", owner: { pid: 1 } }) };
  const { lifecycle, transport } = setup({ world: readyWorld(), lock: held });
  const result = await lifecycle.claim(3, claimOpts());
  assert.equal(result.ok, false);
  assert.equal(result.code, "LOCK_CONTENDED");
  assert.equal(transport.calls.length, 0);
});

test("claim refuses a second live claim by another execution, before any write", async () => {
  const world = readyWorld();
  world.issues[3].comments = [claimComment(OTHER)];
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.claim(3, claimOpts());
  assert.equal(result.ok, false);
  assert.equal(result.code, "CLAIM_HELD");
  assert.equal(result.heldBy, OTHER);
  assertNoWrites(transport);
  assert.equal(world.issues[3].comments.length, 1, "no second claim comment");
});

test("claim refuses a live claim whose execution ID is unreadable (fail closed)", async () => {
  const world = readyWorld();
  world.issues[3].comments = [{ id: "C_x", createdAt: "x", body: "<!-- claim:v1 issue=3 -->\nsomeone wrote this by hand" }];
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.claim(3, claimOpts());
  assert.equal(result.code, "CLAIM_HELD");
  assertNoWrites(transport);
});

test("a finished claim (complete marker after it) no longer blocks a new one", async () => {
  const world = readyWorld();
  world.issues[3].comments = [claimComment(OTHER), { id: "C_c", createdAt: "x", body: "<!-- complete:v1 issue=3 -->\nAccepted" }];
  const { lifecycle } = setup({ world });
  const result = await lifecycle.claim(3, claimOpts());
  assert.equal(result.ok, true);
});

test("claim re-checks every Ready gate under the lock and refuses before writing", async () => {
  const cases = [
    [(w) => { w.issues[3].labels = ["model:standard"]; }, "NOT_READY"],
    [(w) => { w.issues[3].body = contractBody({ drop: ["Scope"] }); }, "NOT_READY"],
    [(w) => { w.issues[4].items[0].status = "In review"; }, "NOT_READY"],
    [(w) => { w.issues[4].state = "OPEN"; }, "NOT_READY"],
    [(w) => { w.issues[3].blockedBy = []; }, "NOT_READY"],
    [(w) => { w.issues[3].items[0].status = "Backlog"; }, "NOT_READY_STATUS"],
    [(w) => { w.issues[3].items[0].status = "Blocked"; }, "NOT_READY_STATUS"],
    [(w) => { w.issues[3].items[0].status = "Done"; }, "NOT_READY_STATUS"],
    [(w) => { w.issues[3].state = "CLOSED"; }, "ISSUE_CLOSED"],
  ];
  for (const [mutate, code] of cases) {
    const world = readyWorld();
    mutate(world);
    const { lifecycle, transport } = setup({ world });
    const result = await lifecycle.claim(3, claimOpts());
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
    assertNoWrites(transport);
  }
});

test("claim fails closed when the claim history is incomplete", async () => {
  const { lifecycle, transport } = setup({ world: readyWorld({ commentsTruncated: true }) });
  const result = await lifecycle.claim(3, claimOpts());
  assert.equal(result.ok, false);
  assert.equal(result.code, "CLAIM_HISTORY_INCOMPLETE");
  assertNoWrites(transport);
});

test("claim refuses a model or effort that does not match the issue's labels unless the mismatch is justified", async () => {
  const cases = [
    [{ model: "deepseek-flash" }, "ROUTING_MISMATCH"],
    [{ model: "gpt-6.1-sol" }, "ROUTING_MISMATCH"],
    [{ effort: "medium" }, "ROUTING_MISMATCH"],
  ];
  for (const [extra, code] of cases) {
    const { lifecycle, transport } = setup({ world: readyWorld() });
    const result = await lifecycle.claim(3, claimOpts(extra));
    assert.equal(result.code, code);
    assertNoWrites(transport);
  }
  const world = readyWorld();
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.claim(3, claimOpts({ effort: "medium", allowMismatch: "session effort cannot be raised from inside the run" }));
  assert.equal(result.ok, true);
  const body = world.issues[3].comments[0].body;
  assert.match(body, /effort `medium`/);
  assert.match(body, /Routing mismatch accepted: session effort cannot be raised/);
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"]);
});

test("claim refuses an unsupported coding model even with --allow-mismatch", async () => {
  for (const model of ["gpt-6-luna", "claude-sonnet-5-5"]) {
    const { lifecycle, transport } = setup({ world: readyWorld() });
    const result = await lifecycle.claim(3, claimOpts({ model, allowMismatch: "deliberate" }));
    assert.equal(result.code, "MODEL_UNSUPPORTED", model);
    assertNoWrites(transport);
  }
});

test("coordinator: Sol is accepted only with a written mismatch reason, never as the DeepSeek implementation", async () => {
  const refusedWorld = readyWorld();
  const refusedSetup = setup({ world: refusedWorld });
  const refused = await refusedSetup.lifecycle.claim(3, claimOpts({ model: "gpt-6.1-sol", effort: "medium" }));
  assert.equal(refused.code, "ROUTING_MISMATCH");
  assertNoWrites(refusedSetup.transport);

  const world = readyWorld();
  const { lifecycle, transport } = setup({ world });
  const accepted = await lifecycle.claim(3, claimOpts({
    model: "gpt-6.1-sol",
    effort: "medium",
    allowMismatch: "Sol coordinates; DeepSeek implements all slices",
  }));
  assert.equal(accepted.ok, true);
  const [comment] = world.issues[3].comments;
  assert.ok(comment.body.includes(SELF), "the coordinator records its own genuine execution ID");
  assert.ok(comment.body.includes("gpt-6.1-sol"), "the coordinator records its actual Sol model");
  assert.ok(comment.body.includes("effort `medium`"), "the coordinator records its logical effort");
  assert.ok(comment.body.includes("effective `high`"), "the coordinator records its effective effort");
  assert.ok(comment.body.includes("Sol coordinates; DeepSeek implements all slices"), "the comment records the written reason");
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"]);
});

test("economy: a supplied effective effort outside the ladder is refused before any request, and Flash claims record effective low", async () => {
  const refusedWorld = readyWorld();
  refusedWorld.issues[3].labels = ["model:economy", "effort:low"];
  const refusedSetup = setup({ world: refusedWorld });
  const refused = await refusedSetup.lifecycle.claim(3, claimOpts({ model: "deepseek-flash", effort: "low", effectiveEffort: "medium" }));
  assert.equal(refused.code, "EFFECTIVE_EFFORT_MISMATCH");
  assert.deepEqual(refusedSetup.transport.calls, [], "refused before any request");
  assertNoWrites(refusedSetup.transport);

  const world = readyWorld();
  world.issues[3].labels = ["model:economy", "effort:low"];
  const { lifecycle } = setup({ world });
  const accepted = await lifecycle.claim(3, claimOpts({ model: "deepseek-flash", effort: "low", effectiveEffort: "low" }));
  assert.equal(accepted.ok, true);
  const [comment] = world.issues[3].comments;
  assert.ok(comment.body.includes("deepseek-flash"), "the claim records the Flash model");
  assert.ok(comment.body.includes("effective `low`"), "the claim records the effective low effort");
});

// ---- claim: success, idempotency, partial writes --------------------------

test("claim posts the marked comment, then sets In progress, under a single lock", async () => {
  const { lifecycle, transport, world, lockCalls } = setup({ world: readyWorld() });
  const result = await lifecycle.claim(3, claimOpts());
  assert.equal(result.ok, true);
  assert.equal(result.claimed, true);
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"]);
  const [comment] = world.issues[3].comments;
  assert.ok(comment.body.startsWith("<!-- claim:v1 issue=3 -->\n"), "exact marker on the first line");
  for (const needle of [
    "mbelinkie/brainstorm #3", SELF, "codex/lifecycle-wrapper-1", BASE_OID, "deepseek-v4-pro", "`effort:high`", "effective `high`", "../quiz-lifecycle", "Owner: mbelinkie",
  ]) assert.ok(comment.body.includes(needle), `claim comment should contain ${needle}`);
  assert.equal(world.issues[3].items[0].status, "In progress");
  assert.equal(transport.mutations()[1].variables.option, STATUS_OPTIONS["In progress"]);
  assert.equal(lockCalls.acquired, 1, "one lock for the re-check and both writes");
  assert.equal(lockCalls.released, 1);
  // the comment we wrote is parseable by our own parser
  assert.equal(parseClaims(world.issues[3].comments, 3).live.executionId, SELF);
});

test("a repeat claim by the same execution reconciles instead of posting a second comment", async () => {
  const world = readyWorld();
  const first = setup({ world });
  assert.equal((await first.lifecycle.claim(3, claimOpts())).claimed, true);
  const second = setup({ world });
  const again = await second.lifecycle.claim(3, claimOpts());
  assert.equal(again.ok, true);
  assert.equal(again.claimed, false);
  assert.equal(again.alreadyClaimed, true);
  assertNoWrites(second.transport);
  assert.equal(world.issues[3].comments.length, 1);
});

test("claim records the effective effort separately and refuses a wrong effective effort", async () => {
  const world = readyWorld();
  world.issues[3].labels = ["model:standard", "effort:medium"];
  const { lifecycle, transport } = setup({ world });
  const ok = await lifecycle.claim(3, claimOpts({ effort: "medium" }));
  assert.equal(ok.ok, true);
  assert.match(world.issues[3].comments[0].body, /effort `medium` \(effective `high`\)/);
  assert.equal(transport.mutationNames().length, 2);

  const w2 = readyWorld();
  w2.issues[3].labels = ["model:standard", "effort:medium"];
  const b = setup({ world: w2 });
  const refused = await b.lifecycle.claim(3, claimOpts({ effort: "medium", effectiveEffort: "low" }));
  assert.equal(refused.code, "EFFECTIVE_EFFORT_MISMATCH");
  assertNoWrites(b.transport);
});

test("partial write: claim comment posted but the status write failed; a re-run finishes the status and posts no second comment", async () => {
  const world = readyWorld({ statusFailures: [502] });
  const first = setup({ world });
  const partial = await first.lifecycle.claim(3, claimOpts());
  assert.equal(partial.ok, false);
  assert.equal(partial.code, "PARTIAL_WRITE");
  assert.equal(partial.commentPosted, true);
  assert.equal(partial.statusSet, false);
  assert.equal(world.issues[3].comments.length, 1);
  assert.equal(world.issues[3].items[0].status, "Ready");

  const second = setup({ world });
  const recovered = await second.lifecycle.claim(3, claimOpts());
  assert.equal(recovered.ok, true);
  assert.equal(recovered.reconciled, true);
  assert.deepEqual(second.transport.mutationNames(), ["LifecycleSetStatus"], "only the status write is replayed");
  assert.equal(world.issues[3].comments.length, 1, "still exactly one claim comment");
  assert.equal(world.issues[3].items[0].status, "In progress");
});

test("partial write: the comment landed but the response was lost; the re-run re-reads and does not repost", async () => {
  const world = readyWorld({ addCommentMode: "land-then-500" });
  const first = setup({ world });
  const uncertain = await first.lifecycle.claim(3, claimOpts());
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.code, "UNCERTAIN");
  assert.equal(uncertain.nextStep, "re-run claim; it re-reads before writing");
  assert.deepEqual(first.transport.mutationNames(), ["LifecycleAddComment"], "the status write must not follow an uncertain comment");
  assert.equal(world.issues[3].comments.length, 1);

  world.addCommentMode = "ok";
  const second = setup({ world });
  const recovered = await second.lifecycle.claim(3, claimOpts());
  assert.equal(recovered.ok, true);
  assert.deepEqual(second.transport.mutationNames(), ["LifecycleSetStatus"]);
  assert.equal(world.issues[3].comments.length, 1);
});

test("a failed comment write leaves the status alone and a re-run posts it once", async () => {
  const world = readyWorld({ addCommentMode: "fail-before" });
  const first = setup({ world });
  const failed = await first.lifecycle.claim(3, claimOpts());
  assert.equal(failed.ok, false);
  assert.deepEqual(first.transport.mutationNames(), ["LifecycleAddComment"]);
  assert.equal(world.issues[3].items[0].status, "Ready");
  world.addCommentMode = "ok";
  const second = setup({ world });
  assert.equal((await second.lifecycle.claim(3, claimOpts())).ok, true);
  assert.equal(world.issues[3].comments.length, 1);
});

test("two different executions racing: the second is refused once the first claim is visible", async () => {
  const world = readyWorld();
  const a = setup({ world });
  assert.equal((await a.lifecycle.claim(3, claimOpts())).ok, true);
  const b = setup({ world, env: { CLAUDE_CODE_SESSION_ID: OTHER } });
  const result = await b.lifecycle.claim(3, claimOpts({ executionId: OTHER }));
  assert.equal(result.code, "CLAIM_HELD");
  assert.equal(result.heldBy, SELF);
  assertNoWrites(b.transport);
});

// ---- block ----------------------------------------------------------------

test("block records the cause and needed decision, sets Blocked, and touches nothing else", async () => {
  const world = readyWorld();
  world.issues[3].items[0].status = "In progress";
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.block(3, { cause: "Gate cannot read blocked-by links", needs: "Matthew to say whether to use the REST dependency endpoint", executionId: SELF });
  assert.equal(result.ok, true);
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"], "no label, priority, size or scope mutation");
  const body = world.issues[3].comments[0].body;
  assert.ok(body.startsWith("<!-- block:v1 issue=3 -->\n"));
  assert.match(body, /Gate cannot read blocked-by links/);
  assert.match(body, /REST dependency endpoint/);
  assert.match(body, /Scope, priority, size and routing labels are unchanged/);
  assert.equal(transport.mutations()[1].variables.option, STATUS_OPTIONS.Blocked);
  assert.equal(world.issues[3].items[0].status, "Blocked");
  assert.deepEqual(world.issues[3].labels, ["model:standard", "effort:high"]);
});

test("block refuses a missing cause or missing needed decision before any call", async () => {
  for (const opts of [{ needs: "x" }, { cause: "x" }, { cause: "  ", needs: "x" }, { cause: "x", needs: "" }]) {
    const { lifecycle, transport } = setup({ world: readyWorld() });
    const result = await lifecycle.block(3, opts);
    assert.equal(result.code, "BLOCK_REASON_REQUIRED");
    assert.equal(transport.calls.length, 0);
  }
});

test("block refuses a routing change without the full written justification, before any call", async () => {
  const full = { attemptedChecks: "ran the claim tests twice", failure: "second-claim test stayed red", remainingRisk: "duplicate claims", nextScope: "fix the live-claim parser only" };
  for (const missing of Object.keys(full)) {
    const justification = { ...full, [missing]: "" };
    const { lifecycle, transport } = setup({ world: readyWorld() });
    const result = await lifecycle.block(3, { cause: "stuck", needs: "a decision", routingChange: "effort:medium", justification });
    assert.equal(result.code, "ROUTING_JUSTIFICATION_REQUIRED", missing);
    assert.equal(transport.calls.length, 0, missing);
  }
  const noJustification = setup({ world: readyWorld() });
  assert.equal((await noJustification.lifecycle.block(3, { cause: "x", needs: "y", routingChange: "model:standard" })).code, "ROUTING_JUSTIFICATION_REQUIRED");
  assert.equal(noJustification.transport.calls.length, 0);
});

test("block rejects a routing change to something the policy does not define (including retired escalation:opus)", async () => {
  const justification = { attemptedChecks: "a", failure: "b", remainingRisk: "c", nextScope: "d" };
  const unknown = setup({ world: readyWorld() });
  assert.equal((await unknown.lifecycle.block(3, { cause: "x", needs: "y", routingChange: "model:advanced", justification })).code, "ROUTING_CHANGE_UNKNOWN");
  assert.equal(unknown.transport.calls.length, 0);
  const opus = setup({ world: readyWorld() });
  assert.equal((await opus.lifecycle.block(3, { cause: "x", needs: "y", routingChange: "escalation:opus", justification })).code, "ROUTING_CHANGE_UNKNOWN");
  assert.equal(opus.transport.calls.length, 0);
});

test("block records a justified routing proposal in the comment but never edits labels", async () => {
  const world = readyWorld();
  const { lifecycle, transport } = setup({ world });
  const justification = { attemptedChecks: "two attempts at the partial-write test", failure: "status replay posts a second comment", remainingRisk: "duplicate claims", nextScope: "the reconcile branch only" };
  const result = await lifecycle.block(3, { cause: "partial-write test red", needs: "a cheaper model for this slice", routingChange: "model:economy", justification });
  assert.equal(result.ok, true);
  const body = world.issues[3].comments[0].body;
  for (const needle of ["Routing change proposed: `model:economy`", "two attempts at the partial-write test", "status replay posts a second comment", "duplicate claims", "the reconcile branch only"]) {
    assert.ok(body.includes(needle), needle);
  }
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"]);
  assert.deepEqual(world.issues[3].labels, ["model:standard", "effort:high"], "labels are changed by the owner, not the wrapper");
});

test("block is idempotent and recovers a partial write without a second comment", async () => {
  const world = readyWorld({ statusFailures: [502] });
  const first = setup({ world });
  const partial = await first.lifecycle.block(3, { cause: "waiting on data", needs: "owner decision" });
  assert.equal(partial.code, "PARTIAL_WRITE");
  const second = setup({ world });
  const recovered = await second.lifecycle.block(3, { cause: "waiting on data", needs: "owner decision" });
  assert.equal(recovered.ok, true);
  assert.deepEqual(second.transport.mutationNames(), ["LifecycleSetStatus"]);
  assert.equal(world.issues[3].comments.length, 1);
  const third = setup({ world });
  const again = await third.lifecycle.block(3, { cause: "waiting on data", needs: "owner decision" });
  assert.equal(again.alreadyBlocked, true);
  assertNoWrites(third.transport);
});

test("block refuses a closed or Done issue and an unknown issue", async () => {
  const done = readyWorld();
  done.issues[3].items[0].status = "Done";
  const a = setup({ world: done });
  assert.equal((await a.lifecycle.block(3, { cause: "x", needs: "y" })).code, "STATUS_NOT_BLOCKABLE");
  assertNoWrites(a.transport);
  const closed = readyWorld();
  closed.issues[3].state = "CLOSED";
  const b = setup({ world: closed });
  assert.equal((await b.lifecycle.block(3, { cause: "x", needs: "y" })).code, "ISSUE_CLOSED");
  assertNoWrites(b.transport);
});

// ---- structure ------------------------------------------------------------

test("the lifecycle modules reach GitHub only through the gate", () => {
  for (const file of ["lifecycle.mjs", "lifecycle-core.mjs"]) {
    const text = fs.readFileSync(new URL(`scripts/roadmap/${file}`, root), "utf8");
    assert.ok(!/child_process/.test(text), `${file} must not import child_process`);
    assert.ok(!/\bfetch\s*\(/.test(text), `${file} must not call fetch`);
    assert.ok(!/api\.github\.com/.test(text), `${file} must not name the API host`);
  }
  const main = fs.readFileSync(new URL("scripts/roadmap/lifecycle.mjs", root), "utf8");
  assert.match(main, /from "\.\/gate\.mjs"/);
  assert.match(main, /gate\.session\(/);
});

test("the CLI help text states the honest limit about atomic claims", async () => {
  const { helpText } = await import("../scripts/roadmap/lifecycle.mjs");
  assert.match(helpText(), /not an atomic claim/i);
  assert.match(helpText(), /one host/i);
  assert.match(helpText(), /dispatcher/i);
});
