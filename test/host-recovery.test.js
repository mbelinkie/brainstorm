import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { autoLockDecision, mergeRecoveredSubmissions, tallyQuestionResults } from "../quiz-core.js";

// room-api.js reads window.QUIZ_PLATFORM_CONFIG at module load (it is a
// browser-only wrapper), so give it a window the way
// test/answer-submission-recovery.test.js does and exercise the real exports.
globalThis.window = globalThis.window || {};
const { classifyLockAndScoreError, lockAndScoreWithRecovery } = await import("../room-api.js");

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// Returns the full source of a named function, and fails loudly when the name
// is gone. A plain indexOf() slice returns -1 when a function is renamed or
// moved, which silently inverts every assertion made against the slice.
function body(name) {
  const start = app.indexOf(name);
  assert.ok(start > -1, `expected app.js to define ${name}`);
  // Skip the parameter list first: a destructured parameter opens a brace of
  // its own, and counting that one as the body makes every later assertion
  // read an empty slice.
  let parens = 0;
  let cursor = start;
  for (; cursor < app.length; cursor += 1) {
    if (app[cursor] === "(") parens += 1;
    else if (app[cursor] === ")") { parens -= 1; if (parens === 0) break; }
  }
  const open = app.indexOf("{", cursor);
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    else if (app[index] === "}") {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

// ---------------------------------------------------------------------------
// C16 — the timer's auto-lock racing the host's Reveal.
// ---------------------------------------------------------------------------

test("classifyLockAndScoreError maps the exact lock_and_score_live_question rejection text", () => {
  // Must stay in sync with supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql.
  assert.equal(classifyLockAndScoreError(new Error("The active question is not open")), "already-locked");
  assert.equal(classifyLockAndScoreError(new Error("Host authorization failed")), "unexpected");
  assert.equal(classifyLockAndScoreError(new Error("Active question is missing from this quiz version")), "unexpected");
  assert.equal(classifyLockAndScoreError(new Error("Failed to fetch")), "unexpected");
  assert.equal(classifyLockAndScoreError("not an Error instance"), "unexpected");
});

test("lockAndScoreWithRecovery returns the scored result on the ordinary path", async () => {
  const client = {
    lockAndScore: async () => ({ revision: 12 }),
    getLeaderboard: async () => [{ id: "p1", points: 3 }],
    getHostRoomState: async () => assert.fail("must not re-read room state when the lock succeeded")
  };
  assert.deepEqual(
    await lockAndScoreWithRecovery({ roomCode: "F7M6VD", hostSecret: "s", client }),
    { status: "locked", revision: 12, players: [{ id: "p1", points: 3 }] }
  );
});

test("lockAndScoreWithRecovery treats an already-locked question as success and resyncs from the server", async () => {
  // The exact live-show race: the expiry timer's auto-lock wins, the host's R
  // press loses on the row lock. Scoring happened once. The reveal must still
  // be able to continue, so this reports a benign outcome, not an error.
  let stateReads = 0;
  const client = {
    lockAndScore: async () => { throw new Error("The active question is not open"); },
    getHostRoomState: async () => { stateReads += 1; return { phase: "question_locked", revision: 21 }; },
    getLeaderboard: async () => [{ id: "p1", points: 5 }]
  };
  const outcome = await lockAndScoreWithRecovery({ roomCode: "F7M6VD", hostSecret: "s", client });
  assert.equal(outcome.status, "already-locked");
  assert.equal(outcome.revision, 21, "revision must come from the server, not from the failed call");
  assert.deepEqual(outcome.players, [{ id: "p1", points: 5 }]);
  assert.equal(stateReads, 1);
});

test("lockAndScoreWithRecovery refuses to claim a lock the server does not agree with", async () => {
  // If the server still says question_open, the rejection did not mean what
  // the classifier assumed. Claiming "locked" here would strand the host in a
  // phase the server disagrees with, which is how the reveal aborted before.
  const client = {
    lockAndScore: async () => { throw new Error("The active question is not open"); },
    getHostRoomState: async () => ({ phase: "question_open", revision: 4 }),
    getLeaderboard: async () => assert.fail("must not refresh the leaderboard for an unresolved lock")
  };
  const outcome = await lockAndScoreWithRecovery({ roomCode: "F7M6VD", hostSecret: "s", client });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.message, "The active question is not open");
});

test("lockAndScoreWithRecovery reports an unexpected rejection without resyncing", async () => {
  const client = {
    lockAndScore: async () => { throw new Error("Host authorization failed"); },
    getHostRoomState: async () => assert.fail("an unexpected rejection is not a race"),
    getLeaderboard: async () => assert.fail("an unexpected rejection is not a race")
  };
  const outcome = await lockAndScoreWithRecovery({ roomCode: "F7M6VD", hostSecret: "s", client });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.message, "Host authorization failed");
});

test("lockAndScoreWithRecovery keeps the lock when only the leaderboard refresh fails", async () => {
  // The question is locked and scored. A failed standings refresh is worth
  // reporting and must never block the reveal.
  const client = {
    lockAndScore: async () => ({ revision: 12 }),
    getLeaderboard: async () => { throw new Error("Failed to fetch"); }
  };
  const outcome = await lockAndScoreWithRecovery({ roomCode: "F7M6VD", hostSecret: "s", client });
  assert.equal(outcome.status, "locked");
  assert.equal(outcome.revision, 12);
  assert.equal(outcome.players, null);
  assert.equal(outcome.error.message, "Failed to fetch");
});

test("autoLockDecision fires once on expiry, only for an open host question", () => {
  const base = { remaining: 0, view: "host", phase: "open", locking: false, now: 1000, retryAt: 0 };
  assert.equal(autoLockDecision(base), true);
  assert.equal(autoLockDecision({ ...base, remaining: 3 }), false);
  assert.equal(autoLockDecision({ ...base, remaining: null }), false);
  assert.equal(autoLockDecision({ ...base, view: "presenter" }), false);
  assert.equal(autoLockDecision({ ...base, phase: "locked" }), false);
  assert.equal(autoLockDecision({ ...base, locking: true }), false, "must not start a second lock while one is in flight");
  assert.equal(autoLockDecision(), false);
});

test("autoLockDecision retries a failed auto-lock after a backoff instead of staying dead", () => {
  // The old latch was cleared only by startTimer(), so one transient RPC
  // failure killed the auto-lock for the rest of the show with nothing shown
  // anywhere. It must come back -- but not on every 250 ms tick.
  const base = { remaining: 0, view: "host", phase: "open", locking: false };
  assert.equal(autoLockDecision({ ...base, now: 5000, retryAt: 7000 }), false, "backed off");
  assert.equal(autoLockDecision({ ...base, now: 6999, retryAt: 7000 }), false, "still backed off");
  assert.equal(autoLockDecision({ ...base, now: 7000, retryAt: 7000 }), true, "auto-lock must recover");
});

test("wiring: app.js shares one in-flight lock between the timer and the host's Reveal", () => {
  const lockQuestion = body("async function lockQuestion(");
  assert.match(lockQuestion, /if \(lockQuestionInFlight\)/, "expected a single in-flight guard");
  assert.match(lockQuestion, /lockQuestionInFlight = lockQuestionOnce\(/);
  assert.match(lockQuestion, /finally \{ lockQuestionInFlight = null;/, "the guard must clear even when the call throws");

  const once = body("async function lockQuestionOnce(");
  assert.match(once, /lockAndScoreWithRecovery\(\{ roomCode, hostSecret \}\)/, "must go through the classifier in room-api.js");
  assert.doesNotMatch(once, /roomApi\.lockAndScore\(/, "the raw RPC must not be called here any more");
  // Read only the part after the RPC call: the local-demo branch above it
  // assigns the same phase, and an indexOf() over the whole body would match
  // that one and assert nothing.
  const afterCall = once.slice(once.indexOf("const outcome = await lockAndScoreWithRecovery"));
  // A benign already-locked outcome must not alert, and must still reach the
  // phase assignment that revealQuestion() gates on.
  assert.ok(afterCall.indexOf('outcome.status === "failed"') > -1);
  assert.ok(afterCall.indexOf('state.phase = "locked"') > afterCall.indexOf('outcome.status === "failed"'));
  assert.match(afterCall, /if \(!auto\) alert\(/, "the timer's own failure must not open a modal on the shared screen");
});

test("wiring: a failed auto-lock clears its latch and backs off", () => {
  const updateTimer = body("function updateTimer(");
  assert.match(updateTimer, /autoLockDecision\(\{/, "the decision must come from the tested predicate");
  assert.match(updateTimer, /lockQuestion\(\{ auto: true \}\)/);
  assert.match(updateTimer, /timerExpiryLocking = false;/, "the latch must be cleared after every attempt");
  assert.match(updateTimer, /timerExpiryLockRetryAt = Date\.now\(\) \+ TIMER_AUTO_LOCK_RETRY_MS/);
});

// ---------------------------------------------------------------------------
// C13 — the Host reload that lost every received answer.
//
// These drive the real Worker module with a stubbed global fetch instead of
// grepping its source, so an authorization or shape regression fails here.
// ---------------------------------------------------------------------------

const { default: quizWorker } = await import("../cloudflare-worker.js");

const workerEnv = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "service-key" };

// Runs one request against the Worker with Supabase stubbed out. `routes` maps
// a URL fragment to the response body; anything unmatched is a test bug.
async function callWorker(path, { headers = {}, env = workerEnv, routes = {}, status = {} } = {}) {
  const requested = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    requested.push(target);
    for (const [fragment, body] of Object.entries(routes)) {
      if (target.includes(fragment)) return Response.json(body, { status: status[fragment] || 200 });
    }
    throw new Error(`unstubbed upstream request: ${target}`);
  };
  try {
    const response = await quizWorker.fetch(new Request(`https://worker.test${path}`, { headers }), env);
    return { response, body: await response.json().catch(() => null), requested };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const hostHeaders = { "x-quiz-room": "f7m6vd", "x-quiz-host-secret": "host-secret" };

const openRoom = {
  "/rpc/get_host_live_room_state": { phase: "question_open", revision: 4, state: { questionId: "q7" } },
  "/rest/v1/sessions?": [{ id: "sess-1" }],
  "/rest/v1/submissions?": [{ player_id: "pl-1", answer: "b" }, { player_id: "pl-2", answer: { "1": "clocks" } }]
};

test("/host-submissions returns the active question's answers keyed by the roster player id", async () => {
  // This is what a reloaded Host needs to rebuild "8 / 12 answers received"
  // and the "Who got it right" summary. player_id is session_players.id --
  // the same identity get_live_leaderboard() keys the roster by.
  const { response, body, requested } = await callWorker("/host-submissions", { headers: hostHeaders, routes: openRoom });
  assert.equal(response.status, 200);
  assert.equal(body.questionId, "q7");
  assert.deepEqual(body.submissions, [{ playerId: "pl-1", answer: "b" }, { playerId: "pl-2", answer: { "1": "clocks" } }]);
  // The host secret is verified by the RPC before either table is read.
  assert.ok(requested[0].includes("/rpc/get_host_live_room_state"));
  assert.ok(requested.some((url) => url.includes("question_id=eq.q7")), "must scope to the active question");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("/host-submissions refuses a request without host credentials", async () => {
  const missing = await callWorker("/host-submissions", { headers: { "x-quiz-room": "f7m6vd" } });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.requested.length, 0, "an unauthorized request must not reach Supabase at all");

  const noRoom = await callWorker("/host-submissions", { headers: { "x-quiz-host-secret": "host-secret" } });
  assert.equal(noRoom.response.status, 401);

  const unconfigured = await callWorker("/host-submissions", { headers: hostHeaders, env: { SUPABASE_URL: "https://db.test" } });
  assert.equal(unconfigured.response.status, 401);
});

test("/host-submissions rejects a bad host secret and never reads a submission", async () => {
  const { response, requested } = await callWorker("/host-submissions", {
    headers: hostHeaders,
    routes: { "/rpc/get_host_live_room_state": { message: "Host authorization failed" }, ...openRoom },
    status: { "/rpc/get_host_live_room_state": 400 }
  });
  assert.equal(response.status, 403);
  assert.ok(!requested.some((url) => url.includes("/rest/v1/submissions")), "a failed host check must not read answers");
});

test("/host-submissions carries no player names or logos", async () => {
  // The closest-number board deliberately embeds session_players for its
  // display; this route must not, because it feeds a count and a tally.
  const { body } = await callWorker("/host-submissions", {
    headers: hostHeaders,
    routes: { ...openRoom, "/rest/v1/submissions?": [{ player_id: "pl-1", answer: "b", player: { display_name: "Ada" } }] }
  });
  assert.deepEqual(body.submissions, [{ playerId: "pl-1", answer: "b" }]);
  assert.equal(JSON.stringify(body).includes("Ada"), false);
});

test("/host-submissions answers empty rather than erroring when there is nothing to recover", async () => {
  const noQuestion = await callWorker("/host-submissions", { headers: hostHeaders, routes: { "/rpc/get_host_live_room_state": { phase: "lobby", state: {} } } });
  assert.equal(noQuestion.response.status, 200);
  assert.deepEqual(noQuestion.body, { questionId: null, submissions: [] });

  const noSession = await callWorker("/host-submissions", { headers: hostHeaders, routes: { ...openRoom, "/rest/v1/sessions?": [] } });
  assert.deepEqual(noSession.body, { questionId: "q7", submissions: [] });

  const failed = await callWorker("/host-submissions", { headers: hostHeaders, routes: { ...openRoom, "/rest/v1/submissions?": { message: "denied" } }, status: { "/rest/v1/submissions?": 401 } });
  assert.equal(failed.response.status, 502);
  assert.equal(failed.body.stage, "submission-lookup");
});

test("/host-submissions answers the cross-origin preflight the custom headers require", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("preflight must not reach Supabase"); };
  try {
    const response = await quizWorker.fetch(new Request("https://worker.test/host-submissions", { method: "OPTIONS" }), workerEnv);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-headers"), "x-quiz-room, x-quiz-host-secret");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("mergeRecoveredSubmissions fills the gaps a host reload left, without overwriting live answers", () => {
  // "b" arrived by broadcast after the recovery request was sent, so it is
  // newer than the row that request read and must survive the merge.
  const merged = mergeRecoveredSubmissions(
    { "pl-1": "b" },
    [{ playerId: "pl-1", answer: "a" }, { playerId: "pl-2", answer: "c" }, { playerId: "pl-3", answer: { "1": "clocks" } }]
  );
  assert.deepEqual(merged, { "pl-1": "b", "pl-2": "c", "pl-3": { "1": "clocks" } });
});

test("mergeRecoveredSubmissions ignores malformed rows and never mutates its input", () => {
  const current = { "pl-1": "a" };
  const merged = mergeRecoveredSubmissions(current, [
    { playerId: "", answer: "x" },
    { playerId: "pl-2" },
    { playerId: "pl-3", answer: null },
    null,
    { answer: "y" },
    { playerId: "pl-4", answer: 0 }
  ]);
  assert.deepEqual(merged, { "pl-1": "a", "pl-4": 0 });
  assert.deepEqual(current, { "pl-1": "a" }, "the caller's object must not be mutated");
  assert.deepEqual(mergeRecoveredSubmissions(), {});
  assert.deepEqual(mergeRecoveredSubmissions({ "pl-1": "a" }, "not an array"), { "pl-1": "a" });
});

test("recovered submissions restore the reveal summary a host reload had emptied", () => {
  // The end-to-end shape of C13: this is exactly what answerResultsPanel()
  // computes, and with the empty `submitted` a reload used to leave, it
  // returns totalSubmitted 0 and the panel renders nothing at all.
  const question = { id: "q7", type: "single_choice", correctOptionIds: ["a"] };
  assert.equal(tallyQuestionResults(question, {}).totalSubmitted, 0, "the bug: nothing to show after a reload");

  const recovered = mergeRecoveredSubmissions({}, [
    { playerId: "pl-1", answer: "a" },
    { playerId: "pl-2", answer: "b" },
    { playerId: "pl-3", answer: "a" }
  ]);
  const results = tallyQuestionResults(question, recovered);
  assert.equal(results.totalSubmitted, 3);
  assert.equal(results.correctCount, 2);
});

test("wiring: the host restores its received answers on reconnect and patches rather than remounts", () => {
  const restore = body("async function restoreHostSubmissions(");
  assert.match(restore, /view !== "host"/, "recovery is host-only");
  assert.match(restore, /\/host-submissions/);
  assert.match(restore, /"x-quiz-host-secret": hostSecret/);
  assert.match(restore, /result\?\.questionId !== questionId/, "a late reply for an old question must be discarded");
  assert.match(restore, /mergeRecoveredSubmissions\(state\.submitted, result\.submissions\)/);
  assert.match(restore, /patchHostLiveRegions\(\)/);
  assert.doesNotMatch(restore, /\brender\(\)/, "a counter update must not remount the operator console");

  const connect = body("async function connectHostedRoom(");
  assert.match(connect, /restoreHostSubmissions\(\)/, "the reload path must actually call it");
});
