// Browser-safe wrapper for the protected Supabase room operations.
// The functions deliberately accept only a publishable key. A host secret and
// player token act as scoped room credentials; secret/service keys never reach
// the browser.

const config = window.QUIZ_PLATFORM_CONFIG || {};
let clientPromise;

async function client() {
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw new Error("Supabase has not been configured for this app.");
  }
  clientPromise ||= import("https://esm.sh/@supabase/supabase-js@2")
    .then(({ createClient }) => createClient(config.supabaseUrl, config.supabasePublishableKey));
  return clientPromise;
}

async function call(name, args) {
  const supabase = await client();
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const wrapped = new Error(error.message);
    // Preserve Postgres/PostgREST error metadata (never credentials) so
    // callers can distinguish an expected RPC rejection from an unexpected
    // auth/network/server failure without re-parsing message text.
    if (error.code) wrapped.code = error.code;
    if (error.details) wrapped.details = error.details;
    if (error.hint) wrapped.hint = error.hint;
    throw wrapped;
  }
  return data;
}

export function randomRoomSecret() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

export const roomApi = {
  configured: Boolean(config.supabaseUrl && config.supabasePublishableKey),
  defaultQuizVersionId: config.defaultQuizVersionId || "",

  createRoom({ quizVersionId = config.defaultQuizVersionId, hostSecret, initialState = {} }) {
    return call("create_live_room", { p_quiz_version_id: quizVersionId, p_host_secret: hostSecret, p_initial_state: initialState });
  },

  listQuizCatalog() {
    return call("list_quiz_catalog", {});
  },

  joinRoom({ roomCode, displayName, playerToken, logoKey = "spark" }) {
    return call("join_live_room", { p_room_code: roomCode, p_display_name: displayName, p_player_token: playerToken, p_logo_key: logoKey });
  },

  getRoomState({ roomCode, playerToken }) {
    return call("get_live_room_state", { p_room_code: roomCode, p_player_token: playerToken });
  },

  submitAnswer({ roomCode, playerToken, questionId, answer, serverRevision }) {
    return call("submit_live_answer", { p_room_code: roomCode, p_player_token: playerToken, p_question_id: questionId, p_answer: answer, p_server_revision: serverRevision });
  },

  lockAndScore({ roomCode, hostSecret }) {
    return call("lock_and_score_live_question", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  chooseDoor({ roomCode, playerToken, doorId }) {
    return call("choose_live_door", { p_room_code: roomCode, p_player_token: playerToken, p_door_id: doorId });
  },

  getHostDoorChoices({ roomCode, hostSecret }) {
    return call("get_host_live_door_choices", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  revealDoorRewards({ roomCode, hostSecret }) {
    return call("reveal_live_door_rewards", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  // Prompt Battle host RPCs (supabase/migrations/0036_prompt_battle_rounds.sql
  // and 0039_prompt_battle_submission.sql). All are host-secret authorized:
  // there is no player-facing battle call yet, and the data they return is
  // host-only.
  openBattleRound({ roomCode, hostSecret }) {
    return call("open_battle_round", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  setBattleEngine({ roomCode, hostSecret, provider, model }) {
    return call("set_battle_engine", { p_room_code: roomCode, p_host_secret: hostSecret, p_provider: provider, p_model: model });
  },

  getHostBattleState({ roomCode, hostSecret }) {
    return call("get_host_battle_state", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  // Idempotent server-side: a repeated call on an already-locked round returns
  // the confirmed battle_review payload rather than reopening submissions.
  lockBattlePrompt({ roomCode, hostSecret }) {
    return call("lock_battle_prompt", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  adjustScore({ roomCode, hostSecret, playerId, points, reason }) {
    return call("adjust_live_score", { p_room_code: roomCode, p_host_secret: hostSecret, p_player_id: playerId, p_points: points, p_reason: reason });
  },

  getLeaderboard({ roomCode, accessToken }) {
    return call("get_live_leaderboard", { p_room_code: roomCode, p_access_token: accessToken });
  },

  getHostScoreEvents({ roomCode, hostSecret }) {
    return call("get_host_score_events", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  getHostQuizDefinition({ roomCode, hostSecret }) {
    return call("get_host_quiz_definition", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  getHostRoomState({ roomCode, hostSecret }) {
    return call("get_host_live_room_state", { p_room_code: roomCode, p_host_secret: hostSecret });
  },

  setRoomState({ roomCode, hostSecret, phase, roundIndex, questionIndex, publicState }) {
    return call("set_live_room_state", { p_room_code: roomCode, p_host_secret: hostSecret, p_phase: phase, p_round_index: roundIndex, p_question_index: questionIndex, p_public_state: publicState });
  }
};

// Exact rejection messages raised by submit_live_answer(). The first three
// come from supabase/migrations/0002_live_room_rpc.sql; the fourth is added by
// 0035_prevent_double_scoring.sql, which stops a reopened question from
// accepting edits to rows that were already locked and scored. Keep this in
// sync with those migrations. All four mean the host closed, locked, or
// advanced the question out from under an in-flight submission — an expected
// concurrency outcome, not a bug. Anything else (auth, network, server, data
// errors) is unexpected and still worth reporting to diagnostics/Sentry.
const SUBMIT_ANSWER_CONFLICT_REASONS = {
  "This question has changed; refresh and try again": "stale-revision",
  "Answers are not open": "question-closed",
  "That is not the active question": "question-changed",
  "Your answer to this question is already locked": "answer-locked"
};

// Conflict reasons a retry cannot fix: the answer will not be accepted however
// many times it is sent. Only "stale-revision" is ambiguous enough to be worth
// re-reading room state for.
const ABANDONED_SUBMIT_REASONS = new Set(["question-closed", "question-changed", "answer-locked"]);

// Classifies a submitAnswer() rejection instead of scattering raw message
// comparisons through app.js.
export function classifySubmitAnswerError(error) {
  const message = error instanceof Error ? error.message : undefined;
  return (message && SUBMIT_ANSWER_CONFLICT_REASONS[message]) || "unexpected";
}

// Exact rejection message raised by lock_and_score_live_question() in
// supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql (unchanged
// since 0003_server_scoring.sql). The row is taken `for update`, so when the
// question timer's auto-lock and the host pressing R race each other, the
// loser blocks on the row lock and then sees this message. It means the
// question is already locked and already scored -- exactly once -- not that
// anything failed.
const LOCK_AND_SCORE_CONFLICT_REASONS = {
  "The active question is not open": "already-locked"
};

// Classifies a lockAndScore() rejection, mirroring classifySubmitAnswerError above.
export function classifyLockAndScoreError(error) {
  const message = error instanceof Error ? error.message : undefined;
  return (message && LOCK_AND_SCORE_CONFLICT_REASONS[message]) || "unexpected";
}

// Exact rejection message raised by choose_live_door() in
// supabase/migrations/0025_between_round_door_bonus.sql. The host may close
// the door-choice phase while a tap is in flight — an expected concurrency
// outcome, not a bug.
const CHOOSE_DOOR_CONFLICT_REASONS = {
  "Door choices are not open": "door-choice-closed"
};

// Classifies a chooseDoor() rejection, mirroring classifySubmitAnswerError above.
export function classifyChooseDoorError(error) {
  const message = error instanceof Error ? error.message : undefined;
  return (message && CHOOSE_DOOR_CONFLICT_REASONS[message]) || "unexpected";
}

// Connection/resource SQLSTATE classes, plus PostgREST's own connectivity
// codes. Everything here fails differently on a second try; a logical
// rejection does not.
const TRANSIENT_SAVE_CODES = /^(08|53|57|58)|^PGRST(000|001|002|504)$/;

// persistHostState() in app.js retries a failed host-state save with backoff,
// but only for failures a second attempt could plausibly clear. Lives here,
// beside the other rejection classifiers, so the retry rule is exercised
// directly by test/answer-submission-recovery.test.js rather than only through
// a source grep of app.js.
export function isTransientSaveError(error) {
  // A request that never reached the server rejects with TypeError.
  if (error instanceof TypeError) return true;
  const code = error?.code ? String(error.code) : "";
  return !code || TRANSIENT_SAVE_CODES.test(code);
}

// submit_live_answer() checks the revision before the question ID, so a
// merely-stale revision on the *same* still-open question and an answer that
// arrived after the host already moved to a different question both surface
// as the identical "This question has changed; refresh and try again"
// message. Given freshly fetched room state, decide whether the submission
// can be retried against the current revision or must be abandoned.
export function planStaleRevisionRecovery({ questionId, freshRoomState }) {
  const stillOpen = freshRoomState?.phase === "question_open";
  const sameQuestion = (freshRoomState?.state?.questionId ?? null) === questionId;
  if (stillOpen && sameQuestion) return { action: "retry", serverRevision: freshRoomState.revision };
  return { action: "abandon", reason: stillOpen ? "question-changed" : "question-closed" };
}

// Submits a player's answer and, only for the ambiguous stale-revision
// rejection, fetches current room state and retries at most once against the
// same still-open question. A closed or changed question is reported back as
// "abandoned" so the caller can show a quiet status instead of an error.
// `client` is injectable for tests; it defaults to the real roomApi.
export async function submitLiveAnswerWithRecovery({ roomCode, playerToken, questionId, answer, serverRevision, client = roomApi }) {
  try {
    const result = await client.submitAnswer({ roomCode, playerToken, questionId, answer, serverRevision });
    return { status: "submitted", result };
  } catch (error) {
    const reason = classifySubmitAnswerError(error);
    if (ABANDONED_SUBMIT_REASONS.has(reason)) return { status: "abandoned", reason };
    if (reason !== "stale-revision") return { status: "failed", error };

    let freshRoomState;
    try {
      freshRoomState = await client.getRoomState({ roomCode, playerToken });
    } catch (stateError) {
      return { status: "failed", error: stateError };
    }
    const recovery = planStaleRevisionRecovery({ questionId, freshRoomState });
    if (recovery.action !== "retry") return { status: "abandoned", reason: recovery.reason };

    try {
      const result = await client.submitAnswer({ roomCode, playerToken, questionId, answer, serverRevision: recovery.serverRevision });
      return { status: "submitted", result, retried: true };
    } catch (retryError) {
      const retryReason = classifySubmitAnswerError(retryError);
      if (retryReason !== "unexpected") return { status: "abandoned", reason: retryReason };
      return { status: "failed", error: retryError };
    }
  }
}

// Locks and scores the active question for the host, treating the
// "already locked" rejection as a benign outcome rather than an error: the
// host's expiry timer and the host's own Reveal keypress both reach this RPC,
// and the loser of that race must still be able to continue to the reveal.
// On that path the authoritative phase and leaderboard are re-read from the
// server instead of being assumed.
//
// Returns one of:
//   { status: "locked",        revision, players, error? }
//   { status: "already-locked", revision, players, error? }
//   { status: "failed",        error }
// A present `error` alongside "locked"/"already-locked" means the question is
// safely locked and scored but the leaderboard refresh failed -- worth
// reporting, never worth blocking the reveal.
export async function lockAndScoreWithRecovery({ roomCode, hostSecret, client = roomApi }) {
  let status = "locked";
  let revision = null;
  try {
    const result = await client.lockAndScore({ roomCode, hostSecret });
    revision = result?.revision ?? null;
  } catch (error) {
    if (classifyLockAndScoreError(error) !== "already-locked") return { status: "failed", error };
    let room;
    try {
      room = await client.getHostRoomState({ roomCode, hostSecret });
    } catch (stateError) {
      return { status: "failed", error: stateError };
    }
    // Only believe the benign reading if the server really has moved past
    // question_open. Anything else means the rejection did not mean what this
    // classifier assumed, and pretending the question is locked would strand
    // the host in a phase the server does not agree with.
    if (!room || room.phase === "question_open") return { status: "failed", error };
    status = "already-locked";
    revision = room.revision ?? null;
  }
  try {
    const players = await client.getLeaderboard({ roomCode, accessToken: hostSecret });
    return { status, revision, players };
  } catch (error) {
    return { status, revision, players: null, error };
  }
}
