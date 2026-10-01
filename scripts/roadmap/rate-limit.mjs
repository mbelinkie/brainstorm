// Pure API-budget accounting for the roadmap gate (playbook section 5).
//
// No I/O and no timers: the caller injects `now`, which is what lets the tests
// run against a fake clock. GraphQL and REST primary budgets are tracked
// separately, and a secondary throttle is a third, independent state, because
// GitHub can throttle while primary points remain (and offers no query for it).
//
// A reading is "unknown" until a response proves otherwise. Unknown, malformed
// or rolled-over quota never authorizes a call; the gate answers it with a
// preflight. A REST `/rate_limit` summary is deliberately never allowed to
// authorize GraphQL work: the playbook records false-green GraphQL figures
// there.

const RESOURCES = ["graphql", "rest"];
// What GitHub puts in the x-ratelimit-resource header for each of ours.
const HEADER_RESOURCE = { graphql: "graphql", rest: "core" };
const DEFAULT_THROTTLE_SECONDS = 60;

const unknownQuota = () => ({ known: false });

// Null, undefined and "" must not coerce to 0, or a missing figure would look
// like an exhausted budget instead of an unknown one.
function num(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function normalizeQuota(raw) {
  if (!raw || typeof raw !== "object") return null;
  const limit = num(raw.limit);
  const remaining = num(raw.remaining);
  const used = raw.used === undefined || raw.used === null ? limit - remaining : num(raw.used);
  const resetAtMs = raw.resetAtMs !== undefined ? num(raw.resetAtMs) : Date.parse(raw.resetAt);
  if (![limit, remaining, used, resetAtMs].every(Number.isFinite)) return null;
  if (limit <= 0 || remaining < 0 || remaining > limit) return null;
  return { known: true, limit, remaining, used, resetAtMs };
}

export function createBudget({ now = Date.now, safetyMargin = 25 } = {}) {
  const quota = { graphql: unknownQuota(), rest: unknownQuota() };
  const reserved = { graphql: 0, rest: 0 };
  const reservations = new Map();
  let blockedUntilMs = 0;
  let nextId = 1;

  const checkResource = (resource) => {
    if (!RESOURCES.includes(resource)) throw new TypeError(`unknown resource: ${resource}`);
  };

  function observe(resource, raw) {
    checkResource(resource);
    const normalized = normalizeQuota(raw);
    // A figure we cannot trust is worse than none: forget what we knew.
    quota[resource] = normalized ?? unknownQuota();
    return normalized !== null;
  }

  function observeHeaders(resource, headers = {}) {
    checkResource(resource);
    const get = (name) => headers[name] ?? headers[name.toLowerCase()];
    const labelled = get("x-ratelimit-resource");
    // Headers describing another resource must not move this one.
    if (labelled && labelled !== HEADER_RESOURCE[resource]) return false;
    const resetSeconds = num(get("x-ratelimit-reset"));
    return observe(resource, {
      limit: get("x-ratelimit-limit"),
      remaining: get("x-ratelimit-remaining"),
      used: get("x-ratelimit-used"),
      resetAtMs: Number.isFinite(resetSeconds) ? resetSeconds * 1000 : NaN,
    });
  }

  // GET /rate_limit returns every resource. Only `core` is used, and only for
  // the REST budget. Its `graphql` entry is ignored on purpose.
  function observeRestSummary(body) {
    const core = body?.resources?.core;
    const resetSeconds = num(core?.reset);
    return observe("rest", {
      limit: core?.limit,
      remaining: core?.remaining,
      used: core?.used,
      resetAtMs: Number.isFinite(resetSeconds) ? resetSeconds * 1000 : NaN,
    });
  }

  function observeThrottle({ retryAfterSeconds, resetAtMs } = {}) {
    const seconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : DEFAULT_THROTTLE_SECONDS;
    const until = Math.max(now() + seconds * 1000, Number.isFinite(resetAtMs) ? resetAtMs : 0);
    blockedUntilMs = Math.max(blockedUntilMs, until);
    return blockedUntilMs;
  }

  function markExhausted(resource, resetAtMs) {
    checkResource(resource);
    const previous = quota[resource];
    const limit = previous.known ? previous.limit : 5000;
    quota[resource] = {
      known: true,
      limit,
      remaining: 0,
      used: limit,
      resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : now() + DEFAULT_THROTTLE_SECONDS * 1000,
    };
  }

  function markUnknown(resource) {
    checkResource(resource);
    quota[resource] = unknownQuota();
  }

  function authorize(resource, cost = 1) {
    checkResource(resource);
    if (blockedUntilMs > now()) {
      return { ok: false, code: "THROTTLED", retryAtMs: blockedUntilMs };
    }
    const current = quota[resource];
    // Once the window has rolled over our "remaining" is stale, not full.
    if (!current.known || now() >= current.resetAtMs) {
      return { ok: false, code: "QUOTA_UNKNOWN" };
    }
    const available = current.remaining - reserved[resource];
    if (available < cost + safetyMargin) {
      return { ok: false, code: "QUOTA_EXHAUSTED", retryAtMs: current.resetAtMs };
    }
    const reservation = { id: nextId++, resource, cost };
    reserved[resource] += cost;
    reservations.set(reservation.id, reservation);
    return { ok: true, reservation };
  }

  function release(reservation) {
    if (!reservation || !reservations.has(reservation.id)) return false;
    reservations.delete(reservation.id);
    reserved[reservation.resource] -= reservation.cost;
    return true;
  }

  // A completed call: the reservation is released, and the response's own
  // quota figures (already observed) are the new truth.
  const settle = (reservation) => release(reservation);

  // A failed or uncertain call: we no longer know what it cost, so the
  // resource goes back to unknown and the next call must preflight.
  function invalidate(reservation) {
    if (!reservation) return false;
    release(reservation);
    quota[reservation.resource] = unknownQuota();
    return true;
  }

  const snapshot = () => ({
    graphql: { ...quota.graphql, reserved: reserved.graphql },
    rest: { ...quota.rest, reserved: reserved.rest },
    blockedUntilMs,
  });

  return {
    observe, observeHeaders, observeRestSummary, observeThrottle,
    markExhausted, markUnknown, authorize, settle, invalidate, snapshot,
  };
}
