import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGate, findTruncatedConnections, withRateLimit } from "../scripts/roadmap/gate.mjs";
import { acquireLock, releaseLock } from "../scripts/roadmap/lock.mjs";
import { createBudget } from "../scripts/roadmap/rate-limit.mjs";

// The roadmap gate is exercised ONLY against a fake transport and a fake clock.
// Nothing here calls GitHub. Every refusal test also asserts that the protected
// call was never sent, because "stops before a protected call" is the contract.

const T0 = Date.parse("2026-10-01T00:00:00Z");

function clock(start = T0) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  };
}

const rl = (c, remaining = 4000, { cost = 1, resetInMs = 3_600_000 } = {}) => ({
  limit: 5000, remaining, used: 5000 - remaining, resetAt: new Date(c.now() + resetInMs).toISOString(), cost,
});
const graphqlOk = (data, rateLimit) => ({ status: 200, headers: {}, body: { data: { ...data, rateLimit } } });
const isPreflight = (request) => request.query?.includes("RoadmapRateLimit");
const noLock = { acquire: () => ({ ok: true, release() {} }) };

function setup(handler, { limits, lock = noLock, logs = [] } = {}) {
  const c = clock();
  const calls = [];
  const transport = {
    calls,
    async request(request) {
      calls.push(request);
      return handler(request, c, calls);
    },
  };
  const budget = createBudget({ now: c.now });
  const gate = createGate({ transport, budget, lock, now: c.now, sleep: c.sleep, log: (entry) => logs.push(entry), limits });
  return { gate, transport, calls, c, budget, logs };
}

// Standard router: a healthy preflight, and `real` for everything else.
const route = (real, remaining = 4000) => (request, c, calls) =>
  isPreflight(request) ? graphqlOk({}, rl(c, remaining)) : real(request, c, calls);

const VIEWER = { viewer: { login: "mbelinkie" } };
const readViewer = { query: "query WhoAmI { viewer { login } }" };

test("withRateLimit adds the rateLimit selection to a read query exactly once", () => {
  const added = withRateLimit("query Q { viewer { login } }");
  assert.match(added, /rateLimit \{ limit remaining used resetAt cost \}/);
  assert.equal(withRateLimit(added), added, "must not add it twice");
});

test("an unknown quota is preflighted first, then the real call is made", async () => {
  const { gate, calls } = setup(route((_r, c) => graphqlOk(VIEWER, rl(c, 3990))));
  const result = await gate.read(readViewer);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(isPreflight(calls[0]), "preflight comes first");
  assert.match(calls[1].query, /rateLimit \{/);
  assert.equal(result.data.viewer.login, "mbelinkie");
});

test("a preflight with no quota data stops before the protected call (MISSING_QUOTA)", async () => {
  const { gate, calls } = setup(() => ({ status: 200, headers: {}, body: { data: { rateLimit: null } } }));
  const result = await gate.read(readViewer);
  assert.equal(result.ok, false);
  assert.equal(result.code, "MISSING_QUOTA");
  assert.equal(calls.length, 1, "only the preflight was sent");
});

test("malformed quota data is treated as missing, not as zero", async () => {
  for (const bad of [{ limit: 5000, remaining: null, used: 0, resetAt: new Date(T0 + 1e6).toISOString() },
    { limit: 5000, remaining: -4, used: 0, resetAt: new Date(T0 + 1e6).toISOString() },
    { limit: 5000, remaining: 10, used: 0, resetAt: "not a date" }]) {
    const { gate, calls } = setup(() => graphqlOk({}, bad));
    const result = await gate.read(readViewer);
    assert.equal(result.code, "MISSING_QUOTA", JSON.stringify(bad));
    assert.equal(calls.length, 1);
  }
});

test("GraphQL primary exhaustion refuses before the protected call and says when to retry", async () => {
  const { gate, calls, c } = setup(route(() => assert.fail("protected call must not be sent"), 20));
  const result = await gate.read(readViewer);
  assert.equal(result.code, "QUOTA_EXHAUSTED");
  assert.equal(result.retryAtMs, T0 + 3_600_000);
  assert.equal(result.retryAt, new Date(c.now() + 3_600_000).toISOString());
  assert.equal(calls.length, 1);
});

test("REST primary exhaustion refuses before the protected call", async () => {
  const { gate, calls } = setup((request) => {
    assert.equal(request.path, "/rate_limit", "only the REST preflight may be sent");
    return { status: 200, headers: {}, body: { resources: { core: { limit: 5000, remaining: 3, used: 4997, reset: (T0 + 600_000) / 1000 } } } };
  });
  const result = await gate.rest({ method: "GET", path: "/repos/x/y" });
  assert.equal(result.code, "QUOTA_EXHAUSTED");
  assert.equal(calls.length, 1);
});

test("a REST /rate_limit summary can never authorize GraphQL work", () => {
  const c = clock();
  const budget = createBudget({ now: c.now });
  const reset = (c.now() + 600_000) / 1000;
  budget.observeRestSummary({ resources: {
    core: { limit: 5000, remaining: 5000, used: 0, reset },
    graphql: { limit: 5000, remaining: 5000, used: 0, reset },
  } });
  assert.equal(budget.authorize("graphql", 1).code, "QUOTA_UNKNOWN");
  assert.equal(budget.authorize("rest", 1).ok, true);
});

test("headers describing a different resource are ignored", () => {
  const budget = createBudget({ now: () => T0 });
  const headers = { "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000", "x-ratelimit-reset": String((T0 + 1e6) / 1000) };
  assert.equal(budget.observeHeaders("graphql", headers), false);
  assert.equal(budget.authorize("graphql", 1).code, "QUOTA_UNKNOWN");
});

test("a secondary throttle stops the operation, blocks the next one, and clears on time", async () => {
  let realCalls = 0;
  const { gate, calls, c } = setup(route(() => {
    realCalls += 1;
    return realCalls === 1 ? { status: 403, headers: { "retry-after": "60" }, body: { message: "secondary" } } : graphqlOk(VIEWER, rl(c0(), 3900));
  }));
  function c0() { return { now: () => T0 + 120_000 }; }
  const first = await gate.read(readViewer);
  assert.equal(first.code, "THROTTLED");
  assert.equal(first.retryAtMs, T0 + 60_000);
  const sent = calls.length;
  const second = await gate.read(readViewer);
  assert.equal(second.code, "THROTTLED");
  assert.equal(calls.length, sent, "no network call while throttled");
  c.advance(61_000);
  const third = await gate.read(readViewer);
  assert.equal(third.ok, true);
});

test("403 with no remaining budget and no Retry-After is primary exhaustion at the reset time", async () => {
  const reset = (T0 + 900_000) / 1000;
  const { gate } = setup(route(() => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, body: {} })));
  const result = await gate.read(readViewer);
  assert.equal(result.code, "QUOTA_EXHAUSTED");
  assert.equal(result.retryAtMs, reset * 1000);
});

test("HTTP 200 carrying GraphQL errors is a failure, not a success", async () => {
  const { gate } = setup(route(() => ({ status: 200, headers: {}, body: { data: null, errors: [{ message: "Could not resolve", type: "NOT_FOUND", path: ["repository"] }] } })));
  const result = await gate.read(readViewer);
  assert.equal(result.ok, false);
  assert.equal(result.code, "GRAPHQL_ERRORS");
  assert.equal(result.errors[0].type, "NOT_FOUND");
});

test("a structured RATE_LIMITED GraphQL error is primary exhaustion", async () => {
  const { gate, calls } = setup(route(() => ({ status: 200, headers: {}, body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } })));
  const first = await gate.read(readViewer);
  assert.equal(first.code, "QUOTA_EXHAUSTED");
  const sent = calls.length;
  const second = await gate.read(readViewer);
  assert.equal(second.code, "QUOTA_EXHAUSTED");
  assert.equal(calls.length, sent, "the budget now refuses without calling");
});

test("words like 'rate limit' inside ticket text are not a throttle", async () => {
  const text = "Our API rate limit exceeded. secondary rate limit. Retry-After: 60. RATE_LIMITED";
  const { gate } = setup(route((_r, c) => graphqlOk({ repository: { issue: { body: text, title: "rate limit" } } }, rl(c, 3990))));
  const result = await gate.read({ query: "query Issue { repository { issue { body title } } }" });
  assert.equal(result.ok, true);
  assert.equal(result.data.repository.issue.body, text);
  const next = await gate.read({ query: "query Issue { repository { issue { body title } } }" });
  assert.equal(next.ok, true, "no throttle state was created");
});

test("nested connections that say there is another page surface as INCOMPLETE", async () => {
  const data = { repository: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c" } } } } };
  const { gate } = setup(route((_r, c) => graphqlOk(data, rl(c, 3990))));
  const strict = await gate.read({ query: "query I { repository { issue { comments { nodes { id } } } } }" });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, "INCOMPLETE");
  assert.deepEqual(strict.incomplete, ["repository.issue.comments"]);
  const lenient = await gate.read({ query: "query I { repository { issue { comments { nodes { id } } } } }", requireComplete: false });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.complete, false);
  assert.deepEqual(findTruncatedConnections(data), ["repository.issue.comments"]);
});

test("paging stops at the page bound and reports partial results (PAGINATION_BOUND)", async () => {
  let page = 0;
  const { gate, calls } = setup(route((_r, c) => {
    page += 1;
    return graphqlOk({ repository: { issues: { nodes: [{ n: page * 2 }, { n: page * 2 + 1 }], pageInfo: { hasNextPage: true, endCursor: `cur${page}` } } } }, rl(c, 3990));
  }));
  const result = await gate.readAll({ query: "query L($first: Int!, $cursor: String) { repository { issues(first: $first, after: $cursor) { nodes { n } pageInfo { hasNextPage endCursor } } } }", connectionPath: ["repository", "issues"], pageSize: 2, maxPages: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PAGINATION_BOUND");
  assert.equal(result.partial.length, 4);
  assert.equal(calls.length, 3, "one preflight plus exactly two pages");
  assert.equal(calls[2].variables.cursor, "cur1", "second page used the first page's cursor");
});

test("paging completes when the last page says so, and rejects bad page sizes without calling", async () => {
  let page = 0;
  const { gate, calls } = setup(route((_r, c) => {
    page += 1;
    return graphqlOk({ repository: { issues: { nodes: [{ n: page }], pageInfo: { hasNextPage: page < 3, endCursor: `cur${page}` } } } }, rl(c, 3990));
  }));
  const query = "query L($first: Int!, $cursor: String) { repository { issues(first: $first, after: $cursor) { nodes { n } pageInfo { hasNextPage endCursor } } } }";
  const done = await gate.readAll({ query, connectionPath: ["repository", "issues"], pageSize: 50, maxPages: 10 });
  assert.equal(done.ok, true);
  assert.deepEqual(done.nodes.map((n) => n.n), [1, 2, 3]);
  const before = calls.length;
  for (const pageSize of [0, 101, 1.5]) {
    const bad = await gate.readAll({ query, connectionPath: ["repository", "issues"], pageSize });
    assert.equal(bad.code, "BAD_REQUEST");
  }
  assert.equal(calls.length, before);
});

test("mutations are serialized with at least one second between them", async () => {
  const times = [];
  const { gate, c } = setup(route((request, clk) => {
    times.push(clk.now());
    return graphqlOk({ ok: true }, rl(clk, 3990));
  }));
  const mutation = { query: "mutation M { noop }" };
  assert.equal((await gate.mutate(mutation)).ok, true);
  assert.equal((await gate.mutate(mutation)).ok, true);
  assert.equal((await gate.mutate(mutation)).ok, true);
  assert.ok(times[1] - times[0] >= 1000, `gap ${times[1] - times[0]}`);
  assert.ok(times[2] - times[1] >= 1000, `gap ${times[2] - times[1]}`);
  assert.ok(c.sleeps.length >= 2);
});

test("an uncertain write is never replayed and forces a fresh preflight", async () => {
  let mutationAttempts = 0;
  const { gate, calls } = setup((request, c) => {
    if (isPreflight(request)) return graphqlOk({}, rl(c, 4000));
    mutationAttempts += 1;
    throw new Error("socket hang up");
  });
  const result = await gate.mutate({ query: "mutation M { noop }" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNCERTAIN");
  assert.equal(result.mutating, true);
  assert.match(result.message, /re-read/);
  assert.equal(mutationAttempts, 1, "the gate must not replay the write");
  await gate.read(readViewer).catch(() => {});
  assert.ok(calls.filter(isPreflight).length >= 2, "quota was invalidated, so the next call preflights again");
});

test("a 5xx is an uncertain outcome", async () => {
  const { gate } = setup(route(() => ({ status: 502, headers: {}, body: null })));
  const result = await gate.read(readViewer);
  assert.equal(result.code, "UNCERTAIN");
});

test("read retries are bounded and honour backoff; the default is no retry", async () => {
  let real = 0;
  const handler = route((_r, c) => {
    real += 1;
    if (real === 1) throw new Error("reset");
    return graphqlOk(VIEWER, rl(c, 3990));
  });
  const noRetry = setup(handler);
  assert.equal((await noRetry.gate.read(readViewer)).code, "UNCERTAIN");

  real = 0;
  const withRetry = setup(handler, { limits: { readRetries: 1, retryBackoffMs: 2000 } });
  assert.equal((await withRetry.gate.read(readViewer)).ok, true);
  assert.deepEqual(withRetry.c.sleeps, [2000]);

  real = -100; // never succeeds within the bound
  const exhausted = setup((request) => { if (isPreflight(request)) return graphqlOk({}, rl(clock(), 4000)); throw new Error("down"); }, { limits: { readRetries: 2, retryBackoffMs: 10 } });
  assert.equal((await exhausted.gate.read(readViewer)).code, "UNCERTAIN");
  assert.deepEqual(exhausted.c.sleeps, [10, 20], "exactly two retries with doubling backoff");
});

test("the quota window rolling over makes the old reading untrustworthy", async () => {
  const { gate, calls, c } = setup(route((_r, clk) => graphqlOk(VIEWER, rl(clk, 3990, { resetInMs: 1000 }))));
  await gate.read(readViewer);
  const preflights = calls.filter(isPreflight).length;
  c.advance(5000);
  await gate.read(readViewer);
  assert.equal(calls.filter(isPreflight).length, preflights + 1);
});

test("reservations reduce what a second reservation can use, and settling returns it", () => {
  const c = clock();
  const budget = createBudget({ now: c.now, safetyMargin: 0 });
  budget.observe("graphql", rl(c, 30));
  const a = budget.authorize("graphql", 20);
  assert.equal(a.ok, true);
  assert.equal(budget.authorize("graphql", 20).code, "QUOTA_EXHAUSTED");
  budget.settle(a.reservation);
  assert.equal(budget.authorize("graphql", 20).ok, true);
});

test("a cached snapshot carries its timestamp and is bypassed when fresh is requested", async () => {
  let real = 0;
  const { gate, c } = setup(route((_r, clk) => { real += 1; return graphqlOk({ n: real }, rl(clk, 3990)); }));
  const first = await gate.readCached({ key: "k", maxAgeMs: 60_000, ...readViewer });
  assert.equal(first.fromCache, false);
  c.advance(10_000);
  const second = await gate.readCached({ key: "k", maxAgeMs: 60_000, ...readViewer });
  assert.equal(second.fromCache, true);
  assert.equal(second.ageMs, 10_000);
  assert.ok(second.fetchedAt);
  const forced = await gate.readCached({ key: "k", maxAgeMs: 60_000, fresh: true, ...readViewer });
  assert.equal(forced.fromCache, false);
  assert.equal(real, 2);
  c.advance(120_000);
  assert.equal((await gate.readCached({ key: "k", maxAgeMs: 60_000, ...readViewer })).fromCache, false, "stale entries are refetched");
});

test("diagnostic logs carry no credentials, variables or query text", async () => {
  const logs = [];
  const { gate } = setup(route((_r, c) => ({
    status: 200,
    headers: { authorization: "token ghp_SECRETSECRETSECRETSECRET1234" },
    body: { data: { viewer: { login: "x" }, rateLimit: rl(c, 3990) } },
  })), { logs });
  await gate.read({ query: "query Secretive { viewer { login } }", variables: { body: "very sensitive text" } });
  await gate.mutate({ query: "mutation Sneaky { noop }", variables: { token: "ghp_ANOTHERSECRETVALUE0000000" } });
  const dump = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(dump, /ghp_|very sensitive|authorization|viewer \{/i);
  assert.ok(logs.every((entry) => entry.op && entry.outcome));
});

test("session() holds the lock once across several operations and releases it", async () => {
  let acquired = 0;
  let released = 0;
  const lock = { acquire: () => { acquired += 1; return { ok: true, release: () => { released += 1; } }; } };
  const { gate } = setup(route((_r, c) => graphqlOk(VIEWER, rl(c, 3990))), { lock });
  const outcome = await gate.session(async (ops) => {
    const a = await ops.read(readViewer);
    const b = await ops.mutate({ query: "mutation M { noop }" });
    return [a.ok, b.ok];
  });
  assert.deepEqual(outcome, [true, true]);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

// ---- lock ---------------------------------------------------------------

function tempLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roadmap-lock-"));
  return { dir, lockPath: path.join(dir, "gate.lock"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("lock contention is refused before any network call", async () => {
  const { lockPath, cleanup } = tempLock();
  try {
    const holder = acquireLock({ lockPath });
    assert.equal(holder.ok, true);
    const lock = { acquire: (options) => acquireLock({ ...options, lockPath }) };
    const { gate, calls } = setup(route(() => assert.fail("must not be reached")), { lock });
    const result = await gate.read(readViewer);
    assert.equal(result.ok, false);
    assert.equal(result.code, "LOCK_CONTENDED");
    assert.equal(calls.length, 0, "no preflight, no call");
    holder.release();
    assert.equal(acquireLock({ lockPath }).ok, true, "free again once released");
  } finally { cleanup(); }
});

test("a live lock owner is never evicted for age alone", () => {
  const { lockPath, cleanup } = tempLock();
  try {
    const old = acquireLock({ lockPath, now: () => 0, label: "ancient but alive" });
    assert.equal(old.ok, true);
    const contender = acquireLock({ lockPath });
    assert.equal(contender.ok, false);
    assert.equal(contender.code, "LOCK_CONTENDED");
    assert.equal(contender.owner.label, "ancient but alive");
    assert.ok(fs.existsSync(lockPath), "the live owner's lock file is untouched");
  } finally { cleanup(); }
});

test("a dead owner's lock on this host is recovered", () => {
  const { lockPath, cleanup } = tempLock();
  try {
    const dead = acquireLock({ lockPath, pid: 999_999 });
    assert.equal(dead.ok, true);
    const recovered = acquireLock({ lockPath, isAlive: () => false });
    assert.equal(recovered.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
  } finally { cleanup(); }
});

test("a lock from another host or with an unreadable record is refused, not deleted", () => {
  const { lockPath, cleanup } = tempLock();
  try {
    acquireLock({ lockPath, host: "some-other-machine", pid: 1 });
    const foreign = acquireLock({ lockPath, isAlive: () => false });
    assert.equal(foreign.code, "LOCK_CONTENDED");
    assert.ok(fs.existsSync(lockPath));
    fs.writeFileSync(lockPath, "{ half-written");
    const corrupt = acquireLock({ lockPath, isAlive: () => false });
    assert.equal(corrupt.code, "LOCK_CONTENDED");
    assert.equal(fs.readFileSync(lockPath, "utf8"), "{ half-written");
  } finally { cleanup(); }
});

test("releasing with a token that is not the owner's leaves the lock alone", () => {
  const { lockPath, cleanup } = tempLock();
  try {
    const mine = acquireLock({ lockPath });
    assert.equal(releaseLock(lockPath, "someone-elses-token"), false);
    assert.ok(fs.existsSync(lockPath));
    assert.equal(mine.release(), true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally { cleanup(); }
});
