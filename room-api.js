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

// Exact rejection messages raised by submit_live_answer() in
// supabase/migrations/0002_live_room_rpc.sql. Keep this in sync with that
// migration. All three mean the host closed, locked, or advanced the
// question out from under an in-flight submission — an expected concurrency
// outcome, not a bug. Anything else (auth, network, server, data errors) is
// unexpected and still worth reporting to diagnostics/Sentry.
const SUBMIT_ANSWER_CONFLICT_REASONS = {
  "This question has changed; refresh and try again": "stale-revision",
  "Answers are not open": "question-closed",
  "That is not the active question": "question-changed"
};

// Classifies a submitAnswer() rejection instead of scattering raw message
// comparisons through app.js.
export function classifySubmitAnswerError(error) {
  const message = error instanceof Error ? error.message : undefined;
  return (message && SUBMIT_ANSWER_CONFLICT_REASONS[message]) || "unexpected";
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
    if (reason === "question-closed" || reason === "question-changed") return { status: "abandoned", reason };
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
