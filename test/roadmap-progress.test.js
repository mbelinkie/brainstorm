import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createGate } from "../scripts/roadmap/gate.mjs";
import { createBudget } from "../scripts/roadmap/rate-limit.mjs";
import { buildProgress, renderHtml, renderMarkdown } from "../scripts/roadmap/progress-core.mjs";
import { runProgress } from "../scripts/roadmap/progress.mjs";

// The read-only progress view (issue #5) against a fake transport and a fake
// clock. Nothing here calls GitHub. Every refusal test also asserts that no
// output file was written and no mutating call was sent.

const root = new URL("../", import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL("docs/roadmap/config.json", root), "utf8"));
const T0 = Date.parse("2026-10-01T12:00:00Z");

const issue = (number, status, extra = {}) => ({
  id: `PVTI_${number}`,
  status: status ? { name: status } : null,
  size: extra.size === null ? null : { name: extra.size ?? "Small" },
  workstream: { name: extra.workstream ?? "Process" },
  acceptance: { name: extra.acceptance ?? "Automated" },
  content: {
    __typename: "Issue", number, title: extra.title ?? `Issue ${number}`, state: status === "Done" ? "CLOSED" : "OPEN",
    url: `https://github.com/mbelinkie/brainstorm/issues/${number}`, repository: { nameWithOwner: extra.repo ?? "mbelinkie/brainstorm" },
    labels: { nodes: (extra.labels ?? ["model:standard", "effort:medium"]).map((name) => ({ name })), pageInfo: { hasNextPage: false } },
  },
});

function board() {
  return [
    issue(1, "Done", { workstream: "Process" }),
    issue(2, "Done", { workstream: "Backend/Scoring", size: "Large" }),
    issue(3, "In progress", { workstream: "Process" }),
    issue(4, "In review", { workstream: "Platform/Ops", size: "Medium" }),
    issue(5, "Ready", { workstream: "Process", labels: ["model:economy", "effort:low"] }),
    issue(6, "Backlog", { workstream: "Player", size: null }),
    issue(7, "Inbox", { workstream: "Authoring", size: "Unknown", labels: [] }),
    issue(8, "Inbox", { workstream: "Authoring", size: "Unknown", labels: [] }),
    issue(9, "Done", { labels: ["setup-test", "model:standard", "effort:medium"] }),
    issue(10, "Backlog", { labels: ["goal"], title: "Roadmap goal" }),
    issue(11, "Blocked", { workstream: "Player", size: "Small" }),
    { id: "PVTI_draft", status: { name: "Backlog" }, content: { __typename: "DraftIssue" } },
  ];
}

const rl = (c) => ({ limit: 5000, remaining: 4000, used: 1000, resetAt: new Date(c() + 3_600_000).toISOString(), cost: 1 });

function setup({ items = board(), pageSize = 5, limits, lock, blockedComments = {}, tweak, fileStore = new Map(), argvExtra = [] } = {}) {
  let t = T0;
  const now = () => t;
  const calls = [];
  const transport = {
    calls,
    async request(request) {
      calls.push(request);
      const q = request.query ?? "";
      const ok = (data) => ({ status: 200, headers: {}, body: { data: { ...data, rateLimit: rl(now) } } });
      if (tweak) {
        const answer = tweak(request, calls);
        if (answer) return answer;
      }
      if (/RoadmapRateLimit/.test(q)) return ok({});
      if (/query ProgressItems\b/.test(q)) {
        const start = request.variables.cursor ? Number(request.variables.cursor) : 0;
        const slice = items.slice(start, start + pageSize);
        const end = start + slice.length;
        return ok({ user: { projectV2: { items: { nodes: slice, pageInfo: { hasNextPage: end < items.length, endCursor: String(end) } } } } });
      }
      if (/query ProgressBlocked\b/.test(q)) {
        const repository = {};
        for (const m of q.matchAll(/(b\d+): issue\(number: (\d+)\)/g)) {
          repository[m[1]] = { comments: { nodes: (blockedComments[Number(m[2])] ?? []).map((body) => ({ body, author: { login: "mbelinkie" } })), pageInfo: { hasPreviousPage: false } } };
        }
        return ok({ repository });
      }
      throw new Error(`unexpected request ${q.slice(0, 60)}`);
    },
  };
  const gate = createGate({
    transport, budget: createBudget({ now }), now, sleep: async (ms) => { t += ms; }, limits,
    lock: lock ?? { acquire: () => ({ ok: true, release() {} }) },
  });
  const files = fileStore;
  const lines = [];
  const errors = [];
  const fsApi = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p),
    writeFileSync: (p, text) => { files.set(p, text); },
  };
  const run = (argv) => runProgress([...argv, ...argvExtra], { gate, config, now, fsApi, out: (s) => lines.push(s), err: (s) => errors.push(s), snapshotPath: "snap.json" });
  return { run, calls, files, lines, errors, advance: (ms) => { t += ms; }, mutations: () => calls.filter((c) => /\bmutation\b/.test(c.query ?? "")) };
}

const noMutations = (s) => assert.deepEqual(s.mutations(), []);

// ---- pure counting ---------------------------------------------------------

test("totals equal the fetched board, with setup-test, goals, placeholders and non-issues handled as specified", () => {
  const model = buildProgress(board(), { nowMs: T0, fetchedAtMs: T0, complete: true });
  assert.equal(model.counts.executable, 7, "issues 1-6 and 11; not Inbox, setup-test, goals or drafts");
  assert.equal(model.counts.done, 2);
  assert.equal(model.counts.remaining, 5);
  assert.equal(model.counts.inbox, 2);
  assert.equal(model.counts.setupTest, 1);
  assert.equal(model.counts.goals, 1);
  assert.equal(model.counts.nonIssue, 1);
  assert.equal(model.counts.executable + model.counts.inbox + model.counts.setupTest + model.counts.goals + model.counts.nonIssue, board().length);
  assert.deepEqual(model.byStatus, { Inbox: 2, Backlog: 1, Blocked: 1, Ready: 1, "In progress": 1, "In review": 1, Done: 2 });
  assert.deepEqual(model.byWorkstream, { Process: 3, "Backend/Scoring": 1, "Platform/Ops": 1, Player: 2, Authoring: 2 });
  assert.equal(model.sizes.Unknown, 3, "two Unknown placeholders and one issue with no size");
  assert.equal(model.sizes.Large, 1);
  assert.deepEqual(model.setupTest.map((i) => i.number), [9]);
  assert.deepEqual(model.inbox.map((i) => i.number), [7, 8]);
  assert.deepEqual(model.routing, { "model:standard / effort:medium": 6, "model:economy / effort:low": 1 });
});

test("a GOAL-titled issue without a goal label is still a goal, not executable work", () => {
  const model = buildProgress([issue(1, "Backlog", { title: "[PB] GOAL: Prompt Battle MVP", labels: [] }), issue(2, "Backlog", { title: "Goalpost fix" })], { nowMs: T0, fetchedAtMs: T0, complete: true });
  assert.equal(model.counts.goals, 1);
  assert.equal(model.counts.executable, 1);
});

test("status values are never invented: an item with no status is shown as (none)", () => {
  const model = buildProgress([issue(1, null)], { nowMs: T0, fetchedAtMs: T0, complete: true });
  assert.equal(model.byStatus["(none)"], 1);
});

test("markdown shows snapshot time, denominators, blocked reasons, links and the honest caveats", () => {
  const model = buildProgress(board(), { nowMs: T0 + 90_000, fetchedAtMs: T0, complete: true, blocked: { 11: "waiting on the venue" } });
  const md = renderMarkdown(model);
  for (const needle of [
    "2026-10-01T12:00:00.000Z", "Done 2 of 7", "Remaining 5", "Blocked", "waiting on the venue", "[#11](https://github.com/mbelinkie/brainstorm/issues/11)",
    "Inbox placeholders", "Excluded setup-test issues", "not an estimate of effort",
  ]) assert.ok(md.includes(needle), needle);
  assert.ok(!md.includes("PARTIAL"));
});

test("a partial fetch is labelled partial with the reason, never complete", () => {
  const model = buildProgress(board().slice(0, 4), { nowMs: T0, fetchedAtMs: T0, complete: false, partialReason: "stopped after 1 page with more remaining" });
  const md = renderMarkdown(model);
  assert.match(md, /PARTIAL/);
  assert.match(md, /stopped after 1 page/);
  assert.match(renderHtml(model), /PARTIAL/);
});

test("html output escapes issue titles", () => {
  const model = buildProgress([issue(1, "Ready", { title: "<script>alert(1)</script> & more" })], { nowMs: T0, fetchedAtMs: T0, complete: true });
  const html = renderHtml(model);
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

// ---- the command, against the fake gate -----------------------------------

test("a run pages with cursors, reads only, and prints the totals", async () => {
  const s = setup({ pageSize: 5 });
  const code = await s.run([]);
  assert.equal(code, 0);
  const itemCalls = s.calls.filter((c) => /query ProgressItems/.test(c.query ?? ""));
  assert.equal(itemCalls.length, 3, "12 items at 5 per page");
  assert.deepEqual(itemCalls.map((c) => c.variables.cursor), [null, "5", "10"]);
  assert.match(s.lines.join("\n"), /Done 2 of 7/);
  noMutations(s);
  assert.ok(s.calls.every((c) => c.kind === "graphql"), "no REST write path is used");
});

test("blocked reasons come from the latest block:v1 comment, and a missing record is said so", async () => {
  const s = setup({ blockedComments: { 11: ["<!-- block:v1 issue=11 -->\n- Cause: old\n", "<!-- block:v1 issue=11 -->\n- Cause: waiting on the venue\n"] } });
  await s.run([]);
  assert.match(s.lines.join("\n"), /waiting on the venue/);
  const none = setup({ blockedComments: {} });
  await none.run([]);
  assert.match(none.lines.join("\n"), /no block record/i);
  noMutations(s);
});

test("a paging bound renders a partial snapshot, writes it flagged, and exits 3", async () => {
  const s = setup({ pageSize: 5, limits: { maxPages: 1 } });
  const code = await s.run(["--html", "out.html"]);
  assert.equal(code, 3);
  assert.match(s.lines.join("\n"), /PARTIAL/);
  assert.match(s.files.get("out.html"), /PARTIAL/);
  assert.equal(JSON.parse(s.files.get("snap.json")).complete, false);
  noMutations(s);
});

test("a truncated nested connection is refused, not rendered, and writes nothing", async () => {
  const items = board();
  items[2].content.labels.pageInfo.hasNextPage = true;
  const s = setup({ items });
  const code = await s.run(["--html", "out.html"]);
  assert.equal(code, 1);
  assert.match(s.errors.join("\n"), /INCOMPLETE/);
  assert.equal(s.files.size, 0);
  noMutations(s);
});

test("gate refusals print the refusal, exit 1 and write no file", async () => {
  const cases = {
    exhausted: (request) => (/RoadmapRateLimit/.test(request.query ?? "")
      ? { status: 200, headers: {}, body: { data: { rateLimit: { limit: 5000, remaining: 3, used: 4997, resetAt: new Date(T0 + 600_000).toISOString(), cost: 1 } } } }
      : null),
    throttled: (request) => (/ProgressItems/.test(request.query ?? "") ? { status: 403, headers: { "retry-after": "30" }, body: {} } : null),
    graphqlErrors: (request) => (/ProgressItems/.test(request.query ?? "") ? { status: 200, headers: {}, body: { errors: [{ message: "boom" }] } } : null),
  };
  for (const [name, tweak] of Object.entries(cases)) {
    const s = setup({ tweak });
    const code = await s.run(["--html", "out.html"]);
    assert.equal(code, 1, name);
    assert.match(s.errors.join("\n"), /REFUSED/, name);
    assert.equal(s.files.size, 0, `${name}: no output file`);
    noMutations(s);
  }
  const locked = setup({ lock: { acquire: () => ({ ok: false, code: "LOCK_CONTENDED", message: "held by a live process" }) } });
  assert.equal(await locked.run([]), 1);
  assert.match(locked.errors.join("\n"), /LOCK_CONTENDED/);
  assert.equal(locked.calls.length, 0, "lock contention stops before any network call");
});

test("a recent snapshot is reused with a visible timestamp; --fresh and age force a read", async () => {
  const s = setup();
  assert.equal(await s.run([]), 0);
  const first = s.calls.length;
  s.advance(30_000);
  assert.equal(await s.run(["--max-age", "60"]), 0);
  assert.equal(s.calls.length, first, "reused: no new request");
  assert.match(s.lines.at(-1), /reused/i);
  assert.match(s.lines.at(-1), /2026-10-01T12:00:00/);
  assert.equal(await s.run(["--max-age", "60", "--fresh"]), 0);
  assert.ok(s.calls.length > first, "--fresh reads again");
  const afterFresh = s.calls.length;
  s.advance(120_000);
  assert.equal(await s.run(["--max-age", "60"]), 0);
  assert.ok(s.calls.length > afterFresh, "an old snapshot is refetched");
});

test("a partial snapshot is never reused", async () => {
  const s = setup({ pageSize: 5, limits: { maxPages: 1 } });
  assert.equal(await s.run([]), 3);
  const first = s.calls.length;
  assert.equal(await s.run(["--max-age", "600"]), 3);
  assert.ok(s.calls.length > first, "re-fetched instead of reusing the partial snapshot");
});

test("bad usage exits 2", async () => {
  const s = setup();
  assert.equal(await s.run(["--max-age", "soon"]), 2);
  assert.equal(await s.run(["--html"]), 2);
  assert.equal(s.calls.length, 0);
});

// ---- structure -----------------------------------------------------------

test("the progress view is read-only and goes through the gate", () => {
  for (const file of ["progress.mjs", "progress-core.mjs"]) {
    const text = fs.readFileSync(new URL(`scripts/roadmap/${file}`, root), "utf8");
    assert.ok(!/child_process|\bfetch\s*\(|api\.github\.com/.test(text), `${file} bypasses the gate`);
    assert.ok(!/\.mutate\(|\bmutation\b|\.rest\(|\.session\(/.test(text), `${file} must not write`);
  }
  const main = fs.readFileSync(new URL("scripts/roadmap/progress.mjs", root), "utf8");
  assert.match(main, /gate\.readAll\(/);
  const inventory = fs.readFileSync(new URL("docs/roadmap/transport-inventory.md", root), "utf8");
  assert.match(inventory, /progress\.mjs/);
});
