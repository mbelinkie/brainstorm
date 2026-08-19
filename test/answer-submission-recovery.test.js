import test from "node:test";
import assert from "node:assert/strict";

// room-api.js reads window.QUIZ_PLATFORM_CONFIG at module load (it is a
// browser-only wrapper). Stub a minimal window so the module can be
// imported and its exported functions exercised directly under node:test,
// the same way it runs in the browser, instead of only string-matching its
// source (see test/reliability-contract.test.js for that older pattern).
globalThis.window = globalThis.window || {};
const { classifySubmitAnswerError, isTransientSaveError, planStaleRevisionRecovery, submitLiveAnswerWithRecovery } = await import("../room-api.js");

test("classifySubmitAnswerError maps the exact submit_live_answer rejection text", () => {
  // These three strings must stay in sync with supabase/migrations/0002_live_room_rpc.sql.
  assert.equal(classifySubmitAnswerError(new Error("This question has changed; refresh and try again")), "stale-revision");
  assert.equal(classifySubmitAnswerError(new Error("Answers are not open")), "question-closed");
  assert.equal(classifySubmitAnswerError(new Error("That is not the active question")), "question-changed");
  assert.equal(classifySubmitAnswerError(new Error("Player is not in this room")), "unexpected");
  assert.equal(classifySubmitAnswerError(new Error("Failed to fetch")), "unexpected");
  assert.equal(classifySubmitAnswerError("not an Error instance"), "unexpected");
});

test("planStaleRevisionRecovery retries only when the same question is still open", () => {
  assert.deepEqual(
    planStaleRevisionRecovery({ questionId: "q2", freshRoomState: { phase: "question_open", revision: 9, state: { questionId: "q2" } } }),
    { action: "retry", serverRevision: 9 }
  );
  assert.deepEqual(
    planStaleRevisionRecovery({ questionId: "q2", freshRoomState: { phase: "question_open", revision: 9, state: { questionId: "q3" } } }),
    { action: "abandon", reason: "question-changed" }
  );
  assert.deepEqual(
    planStaleRevisionRecovery({ questionId: "q2", freshRoomState: { phase: "question_locked", revision: 9, state: { questionId: "q2" } } }),
    { action: "abandon", reason: "question-closed" }
  );
});

test("submitLiveAnswerWithRecovery retries once when the same question has a newer revision", async () => {
  let submitCalls = 0;
  const client = {
    submitAnswer: async ({ serverRevision }) => {
      submitCalls += 1;
      if (submitCalls === 1) {
        assert.equal(serverRevision, 3);
        throw new Error("This question has changed; refresh and try again");
      }
      assert.equal(serverRevision, 9);
      return { submissionId: "sub-1" };
    },
    getRoomState: async () => ({ phase: "question_open", revision: 9, state: { questionId: "q2" } })
  };
  const result = await submitLiveAnswerWithRecovery({ roomCode: "F7M6VD", playerToken: "p1", questionId: "q2", answer: "42", serverRevision: 3, client });
  assert.equal(result.status, "submitted");
  assert.equal(result.retried, true);
  assert.equal(submitCalls, 2);
});

test("submitLiveAnswerWithRecovery quietly abandons when the question closed or changed, without retrying", async () => {
  let getRoomStateCalls = 0;
  const closedClient = {
    submitAnswer: async () => { throw new Error("This question has changed; refresh and try again"); },
    getRoomState: async () => { getRoomStateCalls += 1; return { phase: "question_locked", revision: 9, state: { questionId: "q2" } }; }
  };
  const closedResult = await submitLiveAnswerWithRecovery({ roomCode: "F7M6VD", playerToken: "p1", questionId: "q2", answer: "42", serverRevision: 3, client: closedClient });
  assert.equal(closedResult.status, "abandoned");
  assert.equal(closedResult.reason, "question-closed");
  assert.equal(getRoomStateCalls, 1);

  // The "not the active question" and "answers are not open" rejections are
  // already unambiguous, so they must never trigger a room-state refetch.
  const changedClient = {
    submitAnswer: async () => { throw new Error("That is not the active question"); },
    getRoomState: async () => { throw new Error("must not be called for an unambiguous rejection"); }
  };
  const changedResult = await submitLiveAnswerWithRecovery({ roomCode: "F7M6VD", playerToken: "p1", questionId: "q2", answer: "42", serverRevision: 3, client: changedClient });
  assert.equal(changedResult.status, "abandoned");
  assert.equal(changedResult.reason, "question-changed");
});

test("submitLiveAnswerWithRecovery surfaces genuinely unexpected errors for diagnostics", async () => {
  const authFailureClient = {
    submitAnswer: async () => { throw new Error("Player is not in this room"); },
    getRoomState: async () => { throw new Error("must not be called"); }
  };
  const result = await submitLiveAnswerWithRecovery({ roomCode: "F7M6VD", playerToken: "p1", questionId: "q2", answer: "42", serverRevision: 3, client: authFailureClient });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /Player is not in this room/);

  // A network failure while re-fetching room state to disambiguate a stale
  // revision is also unexpected and must be reported, not swallowed.
  const networkFailureClient = {
    submitAnswer: async () => { throw new Error("This question has changed; refresh and try again"); },
    getRoomState: async () => { throw new Error("Failed to fetch"); }
  };
  const networkResult = await submitLiveAnswerWithRecovery({ roomCode: "F7M6VD", playerToken: "p1", questionId: "q2", answer: "42", serverRevision: 3, client: networkFailureClient });
  assert.equal(networkResult.status, "failed");
  assert.match(networkResult.error.message, /Failed to fetch/);
});

test("submitLiveAnswerWithRecovery never reports success unless the retried RPC actually succeeded", async () => {
  let submitCalls = 0;
  const persistentlyStaleClient = {
    submitAnswer: async () => { submitCalls += 1; throw new Error("This question has changed; refresh and try again"); },
    getRoomState: async () => ({ phase: "question_open", revision: 9, state: { questionId: "q2" } })
  };
  const result = await submitLiveAnswerWithRecovery({ roomCode: "F7M6VD", playerToken: "p1", questionId: "q2", answer: "42", serverRevision: 3, client: persistentlyStaleClient });
  assert.notEqual(result.status, "submitted");
  assert.equal(result.status, "abandoned");
  // Exactly the initial attempt plus one retry — never an unbounded loop.
  assert.equal(submitCalls, 2);
});

// --- host-state save retry classification -----------------------------------

// persistHostState() retries a failed host-state save with backoff, but only
// for failures that can plausibly succeed on a second attempt. Retrying a
// logical rejection just burns the backoff budget and delays the sync banner;
// not retrying a dropped connection desyncs the room for the whole round.
test("isTransientSaveError retries connectivity and resource failures", () => {
  // A fetch that never reached the server rejects with TypeError.
  assert.equal(isTransientSaveError(new TypeError("Failed to fetch")), true);
  // No code at all: an unknown shape gets the benefit of the doubt.
  assert.equal(isTransientSaveError(new Error("boom")), true);
  assert.equal(isTransientSaveError(undefined), true);

  // SQLSTATE classes 08/53/57/58 -- connection, resource, operator
  // intervention, and system error. All differ on a second try.
  for (const code of ["08006", "08003", "53300", "57014", "58030"]) {
    assert.equal(isTransientSaveError(Object.assign(new Error("x"), { code })), true, `${code} should retry`);
  }
  // PostgREST's own connectivity codes.
  for (const code of ["PGRST000", "PGRST001", "PGRST002", "PGRST504"]) {
    assert.equal(isTransientSaveError(Object.assign(new Error("x"), { code })), true, `${code} should retry`);
  }
});

test("isTransientSaveError does not retry logical rejections", () => {
  // 42501 is the permission-denied failure a missing service_role grant
  // produces (see test/migration-hygiene.test.js). Retrying it never helps --
  // it needs a migration, so the host should see the sync banner promptly.
  for (const code of ["42501", "23505", "22P02", "42P01", "PGRST116", "PGRST505"]) {
    assert.equal(isTransientSaveError(Object.assign(new Error("x"), { code })), false, `${code} should not retry`);
  }
});
