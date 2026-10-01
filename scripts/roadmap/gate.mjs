// The roadmap API gate (playbook section 5): the ONLY place repo-owned code is
// allowed to reach GitHub. Every reader and writer goes through here so that a
// primary-budget shortfall, a secondary throttle, a bad response, or a held lock
// stops the operation before it spends quota.
//
// The gate never throws for an expected refusal. Every operation returns either
// { ok: true, ... } or { ok: false, code, message, ... }. Codes:
//   LOCK_CONTENDED   another cooperating process holds the lock
//   QUOTA_UNKNOWN    no trustworthy reading and a preflight was not possible
//   MISSING_QUOTA    the preflight came back without usable quota data
//   QUOTA_EXHAUSTED  primary budget (or this call's reservation) would be exceeded
//   THROTTLED        secondary throttle; retryAtMs says when
//   GRAPHQL_ERRORS   HTTP 200 carrying GraphQL `errors`
//   HTTP_ERROR       a non-throttle 4xx
//   UNCERTAIN        5xx, network failure or unparseable body; outcome unknown
//   INCOMPLETE       a nested connection was truncated
//   PAGINATION_BOUND the page bound was hit with more pages remaining
//   BAD_REQUEST      the caller asked for something the gate refuses (page size)
// The gate never replays a write by itself: an UNCERTAIN mutation must be
// re-read by the caller before any retry.

import { acquireLock } from "./lock.mjs";
import { createBudget } from "./rate-limit.mjs";

export const RATE_LIMIT_SELECTION = "rateLimit { limit remaining used resetAt cost }";
const RATE_LIMIT_QUERY = `query RoadmapRateLimit { ${RATE_LIMIT_SELECTION} }`;

const defaults = {
  graphqlReserveCost: 10,
  restReserveCost: 1,
  minMutationGapMs: 1000,
  readRetries: 0,
  retryBackoffMs: 2000,
  maxPages: 10,
};

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Adds the rateLimit selection to a read query that lacks it, so every read
// refreshes the local budget. Inserted after the first `{`, which is the start of
// the selection set unless a variable default contains an object literal; keep
// such defaults out of gate queries.
export function withRateLimit(query) {
  if (/\brateLimit\b/.test(query)) return query;
  const open = query.indexOf("{");
  if (open === -1) return query;
  return `${query.slice(0, open + 1)} ${RATE_LIMIT_SELECTION} ${query.slice(open + 1)}`;
}

// Paths of every connection in `data` that says there is another page.
export function findTruncatedConnections(data, ignorePaths = []) {
  const found = [];
  const ignore = new Set(ignorePaths.map((p) => p.join(".")));
  (function walk(node, trail) {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && node.pageInfo?.hasNextPage === true && !ignore.has(trail.join("."))) {
      found.push(trail.join("."));
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...trail, key]);
  })(data, []);
  return found;
}

function pathGet(object, pathParts) {
  return pathParts.reduce((node, key) => (node == null ? undefined : node[key]), object);
}

function operationName(query) {
  return /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
}

export function createGate({
  transport,
  budget = createBudget(),
  lock = { acquire: acquireLock },
  now = Date.now,
  sleep = realSleep,
  log = () => {},
  limits = {},
} = {}) {
  if (!transport || typeof transport.request !== "function") {
    throw new TypeError("createGate needs a transport with a request() method");
  }
  const cfg = { ...defaults, ...limits };
  const cache = new Map();
  let heldLock = null;
  let lastMutationAtMs = -Infinity;
  let queue = Promise.resolve();

  // Sanitized on purpose: operation, resource, outcome and quota figures only.
  // Never headers, variables, query text or anything token-shaped.
  function record(entry) {
    try {
      log({ at: new Date(now()).toISOString(), ...entry });
    } catch {
      // diagnostics must never break an operation
    }
  }

  const refuse = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

  const retryInfo = (result) =>
    result.retryAtMs ? { retryAtMs: result.retryAtMs, retryAt: new Date(result.retryAtMs).toISOString() } : {};

  // Serialize in-process operations so reservations and mutation pacing never interleave.
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function withLock(task) {
    if (heldLock) return task();
    const acquired = lock.acquire({ now, label: "roadmap-gate" });
    if (!acquired.ok) {
      record({ op: "lock", outcome: "refused", code: acquired.code });
      return refuse(acquired.code, acquired.message, { owner: acquired.owner });
    }
    heldLock = acquired;
    try {
      return await task();
    } finally {
      heldLock = null;
      acquired.release();
    }
  }

  async function sendRequest(request) {
    try {
      return { response: await transport.request(request) };
    } catch (error) {
      return { failure: error };
    }
  }

  // Turns a transport response into a gate result and updates the budget.
  // `resource` is "graphql" or "rest".
  function interpret(response, resource) {
    const { status, headers = {}, body } = response ?? {};
    if (!Number.isInteger(status) || status === 0 || status >= 500) {
      return refuse("UNCERTAIN", `GitHub did not give a usable answer (status ${status || "none"}); outcome unknown`);
    }
    const retryAfter = Number(headers["retry-after"]);
    const resetSeconds = Number(headers["x-ratelimit-reset"]);
    const resetAtMs = Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : undefined;
    const noRemaining = headers["x-ratelimit-remaining"] === "0";

    // Throttles are recognised ONLY from status and headers (and the structured
    // RATE_LIMITED error below), never from words in a response body: an issue
    // whose text says "rate limit" is just an issue.
    if (status === 429 || (status === 403 && (Number.isFinite(retryAfter) || noRemaining))) {
      if (Number.isFinite(retryAfter) || !noRemaining) {
        const until = budget.observeThrottle({ retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined });
        return refuse("THROTTLED", "GitHub secondary throttle; stop and try again later", retryInfo({ retryAtMs: until }));
      }
      budget.markExhausted(resource, resetAtMs);
      return refuse("QUOTA_EXHAUSTED", "GitHub primary rate limit reached", retryInfo({ retryAtMs: resetAtMs }));
    }
    if (status >= 400) return refuse("HTTP_ERROR", `GitHub returned HTTP ${status}`, { status });

    const observedHeaders = budget.observeHeaders(resource, headers);
    if (resource !== "graphql") return { ok: true, status, data: body, quotaObserved: observedHeaders };

    if (body === null || typeof body !== "object" || (body.data == null && !Array.isArray(body.errors))) {
      return refuse("UNCERTAIN", "GraphQL response had no data and no errors; outcome unknown");
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const limited = body.errors.some((e) => e?.type === "RATE_LIMITED" || e?.extensions?.code === "RATE_LIMITED");
      if (limited) {
        budget.markExhausted("graphql", resetAtMs);
        return refuse("QUOTA_EXHAUSTED", "GitHub GraphQL primary rate limit reached", retryInfo({ retryAtMs: resetAtMs }));
      }
      return refuse("GRAPHQL_ERRORS", "GraphQL returned errors with HTTP 200", {
        errors: body.errors.map((e) => ({ message: e?.message, type: e?.type, path: e?.path })),
        data: body.data ?? null,
      });
    }
    const rateLimit = body.data?.rateLimit;
    const observedBody = rateLimit ? budget.observe("graphql", rateLimit) : false;
    if (!observedBody && !observedHeaders) budget.markUnknown("graphql"); // no evidence this call: next one must preflight
    return { ok: true, status, data: body.data, rateLimit: rateLimit ?? null, quotaObserved: observedBody || observedHeaders };
  }

  async function preflight(resource) {
    const request = resource === "graphql"
      ? { kind: "graphql", query: RATE_LIMIT_QUERY, variables: {} }
      : { kind: "rest", method: "GET", path: "/rate_limit" };
    const { response, failure } = await sendRequest(request);
    if (failure) return refuse("UNCERTAIN", "quota preflight failed to reach GitHub");
    const interpreted = interpret(response, resource);
    if (!interpreted.ok) return interpreted;
    if (resource === "rest") budget.observeRestSummary(interpreted.data);
    const authorizable = budget.authorize(resource, 0);
    if (authorizable.code === "QUOTA_UNKNOWN") {
      return refuse("MISSING_QUOTA", `preflight returned no usable ${resource} quota data; refusing to proceed`);
    }
    if (authorizable.reservation) budget.settle(authorizable.reservation);
    record({ op: "preflight", resource, outcome: "ok" });
    return { ok: true };
  }

  // One protected call: authorize (preflighting if quota is unknown), pace
  // mutations, send, interpret. `cost` is the conservative reservation.
  async function protectedCall({ op, resource, cost, mutating, request }) {
    let auth = budget.authorize(resource, cost);
    if (!auth.ok && auth.code === "QUOTA_UNKNOWN") {
      const checked = await preflight(resource);
      if (!checked.ok) {
        record({ op, resource, outcome: "refused", code: checked.code });
        return checked;
      }
      auth = budget.authorize(resource, cost);
    }
    if (!auth.ok) {
      record({ op, resource, outcome: "refused", code: auth.code });
      const messages = {
        THROTTLED: "GitHub secondary throttle is in effect; stop and try again later",
        QUOTA_EXHAUSTED: "not enough API budget for this operation",
        QUOTA_UNKNOWN: "no trustworthy quota reading",
      };
      return refuse(auth.code, messages[auth.code] ?? auth.code, retryInfo(auth));
    }

    if (mutating) {
      const wait = lastMutationAtMs + cfg.minMutationGapMs - now();
      if (wait > 0) await sleep(wait);
    }
    const { response, failure } = await sendRequest(request);
    if (mutating) lastMutationAtMs = now();

    if (failure) {
      budget.invalidate(auth.reservation);
      record({ op, resource, outcome: "uncertain", code: "UNCERTAIN" });
      return refuse(
        "UNCERTAIN",
        mutating
          ? "the write may or may not have happened; re-read state before retrying (the gate never replays writes)"
          : "the read did not complete",
        { mutating },
      );
    }
    const result = interpret(response, resource);
    if (result.ok) budget.settle(auth.reservation);
    else if (result.code === "UNCERTAIN") budget.invalidate(auth.reservation);
    else budget.settle(auth.reservation);
    if (!result.ok && result.code === "UNCERTAIN") result.mutating = mutating;

    const snapshot = budget.snapshot()[resource];
    record({
      op, resource, outcome: result.ok ? "ok" : "refused", code: result.code,
      cost: result.rateLimit?.cost, remaining: snapshot.known ? snapshot.remaining : undefined,
      resetAt: snapshot.known ? new Date(snapshot.resetAtMs).toISOString() : undefined,
    });
    return result;
  }

  // ---- public operations -------------------------------------------------

  async function readNow({ query, variables = {}, requireComplete = true, ignorePaths = [], retries = cfg.readRetries } = {}) {
    const op = operationName(query);
    let attempt = 0;
    for (;;) {
      const result = await protectedCall({
        op, resource: "graphql", cost: cfg.graphqlReserveCost, mutating: false,
        request: { kind: "graphql", query: withRateLimit(query), variables },
      });
      if (!result.ok) {
        // Bounded retry, reads only, only for uncertain outcomes, honoring backoff.
        if (result.code === "UNCERTAIN" && attempt < retries) {
          await sleep(cfg.retryBackoffMs * 2 ** attempt);
          attempt += 1;
          continue;
        }
        return result;
      }
      const incomplete = findTruncatedConnections(result.data, ignorePaths);
      if (incomplete.length > 0 && requireComplete) {
        return refuse("INCOMPLETE", "a nested connection was truncated; incomplete data cannot support this operation", {
          incomplete, data: result.data,
        });
      }
      return { ...result, complete: incomplete.length === 0, incomplete };
    }
  }

  // Cursor-paged read. The query must declare `$first: Int!` and `$cursor: String`
  // and pass them to the connection at `connectionPath`.
  async function readAllNow({ query, variables = {}, connectionPath, pageSize = 100, maxPages = cfg.maxPages, requireComplete = true } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return refuse("BAD_REQUEST", "pageSize must be an integer from 1 to 100");
    }
    const nodes = [];
    let cursor = null;
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await protectedCall({
        op: operationName(query), resource: "graphql", cost: cfg.graphqlReserveCost, mutating: false,
        request: { kind: "graphql", query: withRateLimit(query), variables: { ...variables, first: pageSize, cursor } },
      });
      if (!result.ok) return { ...result, partial: nodes };
      const incomplete = findTruncatedConnections(result.data, [connectionPath]);
      if (incomplete.length > 0 && requireComplete) {
        return refuse("INCOMPLETE", "a nested connection was truncated", { incomplete, partial: nodes });
      }
      const connection = pathGet(result.data, connectionPath);
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
        return refuse("UNCERTAIN", "paged response did not contain the expected connection", { partial: nodes });
      }
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return { ok: true, nodes, pages: page, complete: true };
      cursor = connection.pageInfo.endCursor;
    }
    return refuse("PAGINATION_BOUND", `stopped after ${maxPages} pages with more remaining`, { partial: nodes, pages: maxPages });
  }

  function mutateNow({ query, variables = {} } = {}) {
    return protectedCall({
      op: operationName(query), resource: "graphql", cost: cfg.graphqlReserveCost, mutating: true,
      request: { kind: "graphql", query, variables },
    });
  }

  function restNow({ method = "GET", path, body } = {}) {
    const mutating = String(method).toUpperCase() !== "GET";
    return protectedCall({
      op: `${String(method).toUpperCase()} ${path}`, resource: "rest", cost: cfg.restReserveCost, mutating,
      request: { kind: "rest", method: String(method).toUpperCase(), path, body },
    });
  }

  // Each public operation takes the lock and queue for itself.
  const alone = (fn) => (args) => serialize(() => withLock(() => fn(args)));
  const read = alone(readNow);
  const readAll = alone(readAllNow);
  const mutate = alone(mutateNow);
  const rest = alone(restNow);

  // Holds the lock across several operations (e.g. a claim: re-check, then
  // write). Inside, use the operations passed to the task; they do not re-lock.
  const session = (task) =>
    serialize(() => withLock(() => task({ read: readNow, readAll: readAllNow, mutate: mutateNow, rest: restNow })));

  // Cached read-only snapshot with a visible timestamp. Consequential
  // transitions must pass { fresh: true } (or use read()) to refresh first.
  async function readCached({ key, maxAgeMs = 60_000, fresh = false, ...args }) {
    const hit = cache.get(key);
    if (hit && !fresh && now() - hit.fetchedAtMs <= maxAgeMs) {
      return { ok: true, data: hit.data, fromCache: true, fetchedAt: new Date(hit.fetchedAtMs).toISOString(), ageMs: now() - hit.fetchedAtMs };
    }
    const result = await read(args);
    if (result.ok) cache.set(key, { data: result.data, fetchedAtMs: now() });
    return result.ok ? { ...result, fromCache: false, fetchedAt: new Date(now()).toISOString(), ageMs: 0 } : result;
  }

  return { read, readAll, mutate, rest, session, readCached, budget };
}
