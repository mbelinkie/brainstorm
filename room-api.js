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
  if (error) throw new Error(error.message);
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
