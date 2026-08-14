import { randomRoomSecret, roomApi } from "./room-api.js";
import { correctOptionId, toPlayerQuestion } from "./quiz-core.js";
import { downloadDiagnostics, recordDiagnostic, startDiagnostics } from "./diagnostics.js";

const params = new URLSearchParams(location.search);
const view = params.get("view") || "landing";
const isHostedRoom = params.has("room");
const roomCode = params.get("room") || "local-demo";
document.body.classList.toggle("is-presentation", view === "presenter");
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("presenter-motion-paused", document.hidden);
});
const localChannel = new BroadcastChannel(`quiz-control:${roomCode}`);
const config = window.QUIZ_PLATFORM_CONFIG || {};
let realtimeChannel = null;
let hostQuizDefinition = null;
let availableQuizzes = [];
let hostMediaObjectUrl = null;
let imageMediaObjectUrls = [];
let timerInterval = null;
let timerExpiryLocking = false;
let activeDrag = null;
let scoreNotificationTimer = null;
let handledPresentationAudioCommand = null;
const presentationAudioPlayer = view === "presenter" ? new Audio() : null;
let presentationAudioSourceKey = null;
let loadedPrivateAudioAssetId = null;
let presentationAudioArmed = false;
let anonymousTextAnswers = [];
let anonymousTextAnswersKey = "";
let anonymousTextAnswersPendingKey = "";
let anonymousTextAnswerRetries = 0;
let autoSubmitTimer = null;
let submissionSequence = Promise.resolve();
const quizWorkerOrigin = config.workerOrigin || location.origin;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const validNumericGuess = (value) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value).trim());
const doorBonusDefinition = () => hostQuizDefinition?.betweenRoundBonus || state.doorBonus || null;
const doorBonusEnabled = () => Boolean(doorBonusDefinition()?.enabled && doorBonusDefinition()?.doors?.length === 3 && (hostQuizDefinition?.rounds?.length || state.question?.totalRounds || 1) > 1);
// Add `src: "./assets/player-icons/file.png"` to an entry when the final
// square artwork arrives. The stable key is what is stored in player records.
const PLAYER_LOGOS = Object.freeze([
  { key: "avatar-01", label: "Avatar 1", src: "./assets/player-icons/avatar-01.png" },
  { key: "avatar-02", label: "Avatar 2", src: "./assets/player-icons/avatar-02.png" },
  { key: "avatar-03", label: "Avatar 3", src: "./assets/player-icons/avatar-03.png" },
  { key: "avatar-04", label: "Avatar 4", src: "./assets/player-icons/avatar-04.png" },
  { key: "avatar-05", label: "Avatar 5", src: "./assets/player-icons/avatar-05.png" },
  { key: "avatar-06", label: "Avatar 6", src: "./assets/player-icons/avatar-06.png" },
  { key: "avatar-07", label: "Avatar 7", src: "./assets/player-icons/avatar-07.png" },
  { key: "avatar-08", label: "Avatar 8", src: "./assets/player-icons/avatar-08.png" },
  { key: "avatar-09", label: "Avatar 9", src: "./assets/player-icons/avatar-09.png" },
  { key: "avatar-10", label: "Avatar 10", src: "./assets/player-icons/avatar-10.png" },
  { key: "avatar-11", label: "Avatar 11", src: "./assets/player-icons/avatar-11.png" },
  { key: "avatar-12", label: "Avatar 12", src: "./assets/player-icons/avatar-12.png" },
  { key: "avatar-13", label: "Avatar 13", src: "./assets/player-icons/avatar-13.png" },
  { key: "avatar-14", label: "Avatar 14", src: "./assets/player-icons/avatar-14.png" },
  { key: "avatar-15", label: "Avatar 15", src: "./assets/player-icons/avatar-15.png" },
  { key: "avatar-16", label: "Avatar 16", src: "./assets/player-icons/avatar-16.png" },
  { key: "avatar-17", label: "Avatar 17", src: "./assets/player-icons/avatar-17.png" },
  { key: "avatar-18", label: "Avatar 18", src: "./assets/player-icons/avatar-18.png" },
  { key: "avatar-19", label: "Avatar 19", src: "./assets/player-icons/avatar-19.png" }
]);
const normalizePlayerLogoKey = (value) => PLAYER_LOGOS.some((logo) => logo.key === value) ? value : PLAYER_LOGOS[0].key;
const playerLogoArtwork = (logo) => logo.src ? `<img src="${escapeHtml(logo.src)}" alt="" />` : `<span>${logo.mark}</span>`;
function playerLogoMarkup(player, className = "") {
  const logo = PLAYER_LOGOS.find((entry) => entry.key === normalizePlayerLogoKey(player?.logoKey)) || PLAYER_LOGOS[0];
  return `<span class="player-logo player-logo--${logo.key} ${className}" aria-hidden="true">${playerLogoArtwork(logo)}</span>`;
}

function playerIdentityBadge() {
  if (!playerName) return "";
  return `<div class="player-identity-badge">${playerLogoMarkup({ logoKey: playerLogoKey }, "player-logo--identity")}<span><small>Playing as</small><strong>${escapeHtml(playerName)}</strong></span></div>`;
}

let hostQuestion = {
  id: "sample-question",
  type: "single_choice",
  round: 1,
  roundTitle: "Name That Tune",
  prompt: "Which song opens with this unmistakable piano line?",
  options: [{ id: "a", label: "A Thousand Miles" }, { id: "b", label: "Clocks" }, { id: "c", label: "Someone Like You" }, { id: "d", label: "Piano Man" }],
  correctOptionIds: ["a"],
  audioLabel: "Audio clip • 00:12",
  audioHelp: "Audio plays in the host tab being shared to the call."
};

const defaultState = {
  phase: "lobby",
  presentationScreen: "title",
  question: { ...toPlayerQuestion(hostQuestion), round: 1, totalRounds: 1, roundTitle: hostQuestion.roundTitle, questionInRound: 1, questionsInRound: 1 },
  submitted: {},
  players: [],
  doorBonus: null,
  doorPicks: [],
  doorResults: [],
  targetRoundIndex: null
};


function publicRoomState() {
  const roundIndex = Math.max(0, (state.question?.round || 1) - 1);
  const questionIndex = Math.max(0, (state.question?.questionInRound || 1) - 1);
  const round = hostQuizDefinition?.rounds?.[roundIndex];
  const playerQuestion = {
    ...toPlayerQuestion(hostQuestion),
    round: roundIndex + 1,
    totalRounds: hostQuizDefinition?.rounds?.length || state.question?.totalRounds || 1,
    roundTitle: round?.title || state.question?.roundTitle || "Round 1",
    questionInRound: questionIndex + 1,
    questionsInRound: round?.questions?.length || state.question?.questionsInRound || 1
  };
  return {
    quizTitle: hostQuizDefinition?.title || state.quizTitle || "Quiz night",
    quizSubtitle: hostQuizDefinition?.titlePage?.subtitle || state.quizSubtitle || "Get ready — we’ll begin shortly.",
    phase: state.phase,
    presentationScreen: state.presentationScreen || "intermission",
    revision: state.revision || 0,
    questionId: hostQuestion.id,
    question: playerQuestion,
    revealedCorrectOptionId: state.phase === "reveal" ? correctOptionId(hostQuestion) : null,
    revealedCorrectOptionIds: state.phase === "reveal" ? hostQuestion.correctOptionIds || (correctOptionId(hostQuestion) ? [correctOptionId(hostQuestion)] : []) : [],
    revealedNumber: state.phase === "reveal" && hostQuestion.type === "closest_number" ? Number(hostQuestion.targetNumber) : null,
    revealImageAssetId: state.phase === "reveal" ? hostQuestion.revealImageAssetId || null : null,
    timerEndsAt: state.timerEndsAt || null,
    timerDurationSeconds: state.timerDurationSeconds || null,
    activeClipId: state.activeClipId || null,
    audioCommand: state.audioCommand || null,
    scoreNotification: state.scoreNotification?.expiresAt && new Date(state.scoreNotification.expiresAt).getTime() > Date.now() ? state.scoreNotification : null,
    doorBonus: hostQuizDefinition?.betweenRoundBonus || state.doorBonus || null,
    doorPicks: state.doorPicks || [],
    doorResults: state.doorResults || [],
    targetRoundIndex: Number.isInteger(state.targetRoundIndex) ? state.targetRoundIndex : null,
    submitted: {},
    players: state.players
  };
}

function setHostQuestion(roundIndex, questionIndex) {
  const round = hostQuizDefinition?.rounds?.[roundIndex];
  const nextQuestion = round?.questions?.[questionIndex];
  if (!nextQuestion) return false;
  hostQuestion = nextQuestion;
  state = {
    ...state,
    phase: "lobby",
    presentationScreen: "intermission",
    questionId: nextQuestion.id,
    question: {
      ...toPlayerQuestion(nextQuestion),
      round: roundIndex + 1,
      totalRounds: hostQuizDefinition?.rounds?.length || 1,
      roundTitle: round.title,
      questionInRound: questionIndex + 1,
      questionsInRound: round.questions.length
    },
    timerEndsAt: null,
    timerDurationSeconds: null,
    activeClipId: null,
    scoreNotification: null,
    submitted: {}
  };
  return true;
}

function questionPosition(questionId = hostQuestion?.id) {
  for (let roundIndex = 0; roundIndex < (hostQuizDefinition?.rounds?.length || 0); roundIndex += 1) {
    const questionIndex = (hostQuizDefinition.rounds[roundIndex].questions || []).findIndex((question) => question.id === questionId);
    if (questionIndex !== -1) return { roundIndex, questionIndex };
  }
  return null;
}

async function advanceQuestion() {
  // Room state is intentionally public and may have been saved by an older
  // client. Navigation must always follow the author’s current question bank.
  const current = questionPosition() || {
    roundIndex: Math.max(0, (state.question?.round || 1) - 1),
    questionIndex: Math.max(0, (state.question?.questionInRound || 1) - 1)
  };
  const roundIndex = current.roundIndex;
  const questionIndex = current.questionIndex;
  const nextInRound = questionIndex + 1;
  const nextRound = nextInRound >= (hostQuizDefinition?.rounds?.[roundIndex]?.questions?.length || 0) ? roundIndex + 1 : roundIndex;
  const nextIndex = nextRound === roundIndex ? nextInRound : 0;
  if (state.phase === "door_reveal") {
    const targetRound = Number(state.targetRoundIndex);
    if (!Number.isInteger(targetRound) || !setHostQuestion(targetRound, 0)) return;
    state.targetRoundIndex = targetRound;
    state.doorBonus = hostQuizDefinition?.betweenRoundBonus || state.doorBonus;
    await persistHostState(); emit(); render(); return;
  }
  if (nextRound !== roundIndex && nextRound < (hostQuizDefinition?.rounds?.length || 0) && doorBonusEnabled()) {
    await openDoorChoice(nextRound);
    return;
  }
  if (!setHostQuestion(nextRound, nextIndex)) {
    state.phase = "complete";
    await persistHostState();
    emit();
    render();
    return;
  }
  await persistHostState();
  emit();
  render();
}

async function openDoorChoice(targetRoundIndex) {
  state = {
    ...state,
    phase: "door_choice",
    presentationScreen: "doors",
    targetRoundIndex,
    doorBonus: hostQuizDefinition?.betweenRoundBonus || state.doorBonus,
    doorPicks: [],
    doorResults: [],
    timerEndsAt: null,
    timerDurationSeconds: null,
    submitted: {}
  };
  await persistHostState(); emit(); render();
}

async function acceptDoorChoice(payload) {
  if (view !== "host" || state.phase !== "door_choice" || !payload?.playerId) return;
  const hostSecret = getHostSecret();
  if (params.has("room") && hostSecret) {
    try { state.doorPicks = await roomApi.getHostDoorChoices({ roomCode, hostSecret }); }
    catch (error) { recordDiagnostic("door-choice-refresh", error, { roomCode }); return; }
  } else {
    const next = { playerId: payload.playerId, playerName: payload.playerName || "Guest", logoKey: normalizePlayerLogoKey(payload.logoKey), doorId: payload.doorId };
    state.doorPicks = [...(state.doorPicks || []).filter((entry) => entry.playerId !== next.playerId), next];
  }
  emit(); render();
}

async function jumpToQuestion() {
  const value = document.querySelector("[data-jump-question]")?.value;
  const [roundIndex, questionIndex] = String(value || "").split(":").map(Number);
  if (!Number.isInteger(roundIndex) || !Number.isInteger(questionIndex) || !setHostQuestion(roundIndex, questionIndex)) return;
  await persistHostState();
  emit();
  render();
}

let state = structuredClone(defaultState);
let playerId = sessionStorage.getItem("musicTriviaPlayerId") || crypto.randomUUID();
sessionStorage.setItem("musicTriviaPlayerId", playerId);
let playerName = sessionStorage.getItem("musicTriviaPlayerName") || "";
let playerLogoKey = normalizePlayerLogoKey(sessionStorage.getItem("quizPlayerLogoKey"));

// A host may open the shareable presentation in a second tab. Keep this room
// credential browser-local and same-origin only; it is never added to a URL.
const hostSecretKey = (code = roomCode) => `quiz-host-secret:${code}`;
function getHostSecret(code = roomCode) {
  const key = hostSecretKey(code);
  const secret = localStorage.getItem(key) || sessionStorage.getItem(key);
  if (secret && !localStorage.getItem(key)) localStorage.setItem(key, secret);
  return secret;
}
function saveHostSecret(code, secret) {
  if (!secret) return;
  const key = hostSecretKey(code);
  localStorage.setItem(key, secret);
  sessionStorage.setItem(key, secret);
}
let selected = null;

const app = document.querySelector("#app");

function acceptSubmission(payload) {
  if (view !== "host" || state.phase !== "open" || !payload?.playerId) return;
  state.submitted[payload.playerId] = payload.answer;
  if (!state.players.find((player) => player.id === payload.playerId)) state.players.push({ id: payload.playerId, name: payload.playerName || "Guest", logoKey: normalizePlayerLogoKey(payload.playerLogoKey), points: 0 });
  // A submission only changes the Host's received count. Rebroadcasting the
  // full room state here remounts the presentation for every phone tap.
  render();
}

function receive(message) {
  const data = message?.data || message;
  if (data?.type === "state") {
    const incomingQuestionId = data.state?.questionId || data.state?.question?.id;
    const previousQuestionId = state.questionId || state.question?.id;
    if (incomingQuestionId && incomingQuestionId !== previousQuestionId) selected = null;
    const priorPlayerRenderKey = view === "player" ? playerRenderKey(state) : null;
    const priorPresenterRenderKey = view === "presenter" ? presenterRenderKey(state) : null;
    state = data.state;
    const playerChanged = view === "player" && priorPlayerRenderKey !== playerRenderKey(state);
    const presenterChanged = view === "presenter" && priorPresenterRenderKey !== presenterRenderKey(state);
    if (!["player", "presenter"].includes(view) || playerChanged || presenterChanged) render();
    else if (view === "presenter" && presentationAudioArmed) applyPresentationAudioCommand().catch((error) => console.warn("Presentation clip unavailable.", error));
  }
  if (data?.type === "submission") acceptSubmission(data.payload);
  if (data?.type === "presence") acceptPlayerPresence(data.payload);
  if (data?.type === "door-choice") acceptDoorChoice(data.payload);
}

function playerRenderKey(roomState) {
  return JSON.stringify({
    phase: roomState?.phase,
    presentationScreen: roomState?.presentationScreen,
    questionId: roomState?.questionId,
    question: roomState?.question,
    revealedCorrectOptionId: roomState?.revealedCorrectOptionId,
    revealedCorrectOptionIds: roomState?.revealedCorrectOptionIds,
    revealedNumber: roomState?.revealedNumber,
    revealImageAssetId: roomState?.revealImageAssetId,
    doorBonus: roomState?.doorBonus,
    doorPicks: roomState?.doorPicks,
    doorResults: roomState?.doorResults,
    targetRoundIndex: roomState?.targetRoundIndex,
    timerEndsAt: roomState?.timerEndsAt,
    timerDurationSeconds: roomState?.timerDurationSeconds
  });
}

function presenterRenderKey(roomState) {
  // Audio controls increment the server revision and replace audioCommand, but
  // neither change is visual. Keep the presentation DOM mounted so a host cue
  // cannot flash the shared screen while still applying the command above.
  const { audioCommand, revision, submitted, ...visualState } = roomState || {};
  return JSON.stringify(visualState);
}
localChannel.onmessage = receive;

function emit() {
  if (view !== "host") return;
  const outboundState = params.has("room") ? publicRoomState() : state;
  localChannel.postMessage({ type: "state", state: outboundState });
  realtimeChannel?.send({ type: "broadcast", event: "state", payload: { state: outboundState } });
}

async function persistHostState() {
  const hostSecret = getHostSecret();
  if (!hostSecret || !params.has("room")) return;
  try {
    const phaseMap = { lobby: "lobby", open: "question_open", locked: "question_locked", reveal: "answer_reveal", door_choice: "door_choice", door_reveal: "door_reveal", complete: "complete" };
    const result = await roomApi.setRoomState({
      roomCode,
      hostSecret,
      phase: phaseMap[state.phase] || "lobby",
      roundIndex: ["door_choice", "door_reveal"].includes(state.phase) && Number.isInteger(state.targetRoundIndex) ? state.targetRoundIndex : Math.max(0, (state.question?.round || 1) - 1),
      questionIndex: Math.max(0, (state.question?.questionInRound || 1) - 1),
      publicState: publicRoomState()
    });
    state.revision = result.revision;
  } catch (error) {
    recordDiagnostic("host-state-save", error, { roomCode });
    console.warn("Could not save host room state.", error);
  }
}

function sendSubmission(answer) {
  const payload = { playerId, playerName, playerLogoKey, answer };
  localChannel.postMessage({ type: "submission", payload });
  realtimeChannel?.send({ type: "broadcast", event: "submission", payload });
}

function announcePlayerPresence() {
  const payload = { playerId, playerName, playerLogoKey };
  localChannel.postMessage({ type: "presence", payload });
  realtimeChannel?.send({ type: "broadcast", event: "presence", payload });
}

function acceptPlayerPresence(payload) {
  if (view !== "host" || !payload?.playerId || state.players.some((player) => player.id === payload.playerId)) return;
  state.players.push({ id: payload.playerId, name: payload.playerName || "Guest", logoKey: normalizePlayerLogoKey(payload.playerLogoKey), points: 0 });
  // Presence is transport-only: persisting it would increment the answer
  // revision while a player is entering an answer.
  emit();
  render();
}

async function connectHostedRoom() {
  if (!config.supabaseUrl || !config.supabasePublishableKey) return;
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey);
    realtimeChannel = supabase.channel(`quiz-room:${roomCode}`, { config: { broadcast: { self: false } } });
    realtimeChannel.on("broadcast", { event: "state" }, ({ payload }) => {
      receive({ type: "state", state: payload?.state });
    });
    realtimeChannel.on("broadcast", { event: "submission" }, ({ payload }) => receive({ type: "submission", payload }));
    realtimeChannel.on("broadcast", { event: "presence" }, ({ payload }) => receive({ type: "presence", payload }));
    realtimeChannel.on("broadcast", { event: "door-choice" }, ({ payload }) => receive({ type: "door-choice", payload }));
    realtimeChannel.on("broadcast", { event: "request-state" }, () => {
      if (view === "host") emit();
    });
    realtimeChannel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      if (view === "host") emit();
      else realtimeChannel.send({ type: "broadcast", event: "request-state", payload: {} });
    });
    if (["host", "presenter"].includes(view) && params.has("room")) {
      const hostSecret = getHostSecret();
      if (hostSecret) {
        const definition = await roomApi.getHostQuizDefinition({ roomCode, hostSecret });
        hostQuizDefinition = definition;
        const savedRoom = await roomApi.getHostRoomState({ roomCode, hostSecret });
        const hasSavedQuestion = savedRoom.state?.questionId;
        const savedQuestionPosition = hasSavedQuestion ? questionPosition(savedRoom.state.questionId) : null;
        if (hasSavedQuestion && setHostQuestion(savedQuestionPosition?.roundIndex ?? savedRoom.roundIndex, savedQuestionPosition?.questionIndex ?? savedRoom.questionIndex)) {
          state = { ...state, ...savedRoom.state, revision: savedRoom.revision, phase: ({ lobby: "lobby", question_open: "open", question_locked: "locked", answer_reveal: "reveal", door_choice: "door_choice", door_reveal: "door_reveal", complete: "complete" })[savedRoom.phase] || "lobby" };
          if (["door_choice", "door_reveal"].includes(state.phase)) {
            state.targetRoundIndex = savedRoom.roundIndex;
            state.doorBonus = hostQuizDefinition?.betweenRoundBonus || state.doorBonus;
            state.doorPicks = await roomApi.getHostDoorChoices({ roomCode, hostSecret });
            if (state.phase === "door_reveal") state.doorResults = state.doorPicks;
          }
        } else if (setHostQuestion(0, 0)) {
          state.presentationScreen = "title";
          await persistHostState();
        }
        emit();
        render();
      }
    }
    if (view === "player" && params.has("room") && playerName) {
      const joined = await roomApi.joinRoom({ roomCode, displayName: playerName, playerToken: playerId, logoKey: playerLogoKey });
      state = { ...state, ...joined.state, revision: joined.revision };
      announcePlayerPresence();
      render();
    }
  } catch (error) {
    recordDiagnostic("hosted-room-connect", error, { roomCode, view });
    console.warn("Hosted room unavailable; continuing with local demo transport.", error);
  }
}

async function setPhase(phase) {
  state.phase = phase;
  if (phase === "open") state.presentationScreen = "question";
  if (phase === "reveal") {
    state.revealedCorrectOptionId = correctOptionId(hostQuestion);
    state.revealedCorrectOptionIds = hostQuestion.correctOptionIds || (state.revealedCorrectOptionId ? [state.revealedCorrectOptionId] : []);
    state.revealedNumber = hostQuestion.type === "closest_number" ? Number(hostQuestion.targetNumber) : null;
    state.revealImageAssetId = hostQuestion.revealImageAssetId || null;
  }
  await persistHostState();
  emit();
  render();
}
async function lockQuestion({ renderAfter = true } = {}) {
  const hostSecret = getHostSecret();
  if (!params.has("room") || !hostSecret) {
    state.phase = "locked";
    if (renderAfter) await setPhase("locked");
    return;
  }
  try {
    const result = await roomApi.lockAndScore({ roomCode, hostSecret });
    state.phase = "locked";
    state.revision = result.revision;
    state.players = await roomApi.getLeaderboard({ roomCode, accessToken: hostSecret });
    if (renderAfter) {
      await persistHostState();
      emit();
      render();
    }
  } catch (error) {
    recordDiagnostic("lock-and-score", error, { roomCode, questionId: state.questionId });
    alert(`Could not lock and score this question: ${error.message}`);
  }
}
async function revealQuestion() {
  if (state.phase === "open") await lockQuestion({ renderAfter: false });
  if (state.phase !== "locked") return;
  await setPhase("reveal");
}
async function revealDoorRewards() {
  if (state.phase !== "door_choice") return;
  const hostSecret = getHostSecret();
  try {
    if (params.has("room") && hostSecret) {
      const revealed = await roomApi.revealDoorRewards({ roomCode, hostSecret });
      state.revision = revealed.revision;
      state.doorResults = revealed.results || [];
    } else {
      state.doorResults = (state.doorPicks || []).map((pick) => {
        const door = doorBonusDefinition()?.doors?.find((entry) => entry.id === pick.doorId);
        const roll = Math.random() * 100;
        let cumulative = 0;
        const outcome = (door?.outcomes || []).find((entry) => { cumulative += Number(entry.chancePercent); return roll < cumulative; }) || door?.outcomes?.at(-1) || { multiplier: 1 };
        return { ...pick, multiplier: Number(outcome.multiplier) };
      });
    }
    state.phase = "door_reveal";
    await persistHostState(); emit(); render();
  } catch (error) {
    recordDiagnostic("door-reveal", error, { roomCode });
    alert(`Could not reveal door rewards: ${error.message}`);
  }
}
function reset() { state = structuredClone(defaultState); selected = null; emit(); render(); }

function timerRemaining() {
  if (!state.timerEndsAt) return null;
  return Math.max(0, Math.ceil((new Date(state.timerEndsAt).getTime() - Date.now()) / 1000));
}

function formatTimer(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function timerDisplay() {
  const remaining = timerRemaining();
  if (remaining === null) return "";
  return `<span class="question-timer ${remaining === 0 ? "is-expired" : ""}" data-timer-readout>${remaining === 0 ? "Time elapsed" : formatTimer(remaining)}</span>`;
}

function timerControls() {
  if (view !== "host" || state.phase !== "open") return "";
  const running = timerRemaining() !== null && timerRemaining() > 0;
  return `<div class="timer-controls"><strong>Question timer</strong>${running ? `<span>${timerDisplay()}</span><button class="btn btn-secondary" data-clear-timer>Stop timer</button>` : `<div><button class="btn btn-secondary" data-start-timer="15">15 sec</button><button class="btn btn-secondary" data-start-timer="20">20 sec</button><button class="btn btn-secondary" data-start-timer="30">30 sec</button><button class="btn btn-secondary" data-start-timer="45">45 sec</button><button class="btn btn-secondary" data-start-timer="60">60 sec</button></div>`}</div>`;
}

async function startTimer(seconds) {
  state.timerDurationSeconds = seconds;
  state.timerEndsAt = new Date(Date.now() + seconds * 1000).toISOString();
  timerExpiryLocking = false;
  await persistHostState();
  emit();
  render();
}

async function clearTimer() {
  state.timerEndsAt = null;
  state.timerDurationSeconds = null;
  await persistHostState();
  emit();
  render();
}

function updateTimer() {
  const remaining = timerRemaining();
  document.querySelectorAll("[data-timer-readout]").forEach((node) => {
    node.textContent = remaining === null ? "" : remaining === 0 ? "Time elapsed" : formatTimer(remaining);
    node.classList.toggle("is-expired", remaining === 0);
  });
  if (remaining === 0 && view === "host" && state.phase === "open" && !timerExpiryLocking) {
    timerExpiryLocking = true;
    lockQuestion();
  }
}

function startTimerTicker() {
  clearInterval(timerInterval);
  if (timerRemaining() === null) return;
  updateTimer();
  timerInterval = setInterval(updateTimer, 250);
}

function shell(content, isPlayer = false) {
  return `<section class="${isPlayer ? "player-shell" : "shell"}">${content}</section>`;
}

function brandTopbar(host = false) {
  return `<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">K</span><span>QUIZ CONTROL</span></div>${host ? '<span class="host-badge">HOST VIEW</span>' : `<span class="room-badge">ROOM ${roomCode}</span>`}</header>`;
}

function preflightChecklist() {
  const items = hostQuizDefinition?.preflightChecklist || ["Share this Chrome tab with tab audio enabled.", "Confirm the player join link is available.", "Check the first clip and timer before opening the question."];
  const key = `quiz-preflight:${roomCode}`;
  let completed = {};
  try { completed = JSON.parse(sessionStorage.getItem(key) || "{}"); } catch { /* Start with an empty checklist. */ }
  return `<section class="preflight-checklist"><strong>Before you start</strong>${items.map((item, index) => `<label><input type="checkbox" data-preflight-item="${index}" ${completed[index] ? "checked" : ""} /><span>${escapeHtml(item)}</span></label>`).join("")}</section>`;
}

function roundProgress() {
  const total = Math.max(1, hostQuizDefinition?.rounds?.length || 1);
  const current = Math.min(total, Math.max(1, state.question?.round || 1));
  return `<span class="progress" aria-label="Round ${current} of ${total}">${Array.from({ length: total }, (_, index) => `<i class="${index < current ? "active" : ""}"></i>`).join("")}</span>`;
}

function hostUtilityControls() {
  return `<div class="host-utilities"><button class="btn btn-secondary" data-toggle-shortcuts>Shortcuts</button></div>`;
}

function questionJumpControls() {
  if (view !== "host" || !hostQuizDefinition?.rounds?.length) return "";
  const currentValue = `${Math.max(0, Number(state.question?.round || 1) - 1)}:${Math.max(0, Number(state.question?.questionInRound || 1) - 1)}`;
  const choices = hostQuizDefinition.rounds.map((round, roundIndex) => `<optgroup label="${escapeHtml(round.title || `Round ${roundIndex + 1}`)}">${(round.questions || []).map((question, questionIndex) => `<option value="${roundIndex}:${questionIndex}" ${currentValue === `${roundIndex}:${questionIndex}` ? "selected" : ""}>${questionIndex + 1}. ${escapeHtml(question.prompt || question.id || "Untitled question")}</option>`).join("")}</optgroup>`).join("");
  return `<div class="question-jump"><strong>Testing shortcut</strong><span>Jump to any question. This resets that question to its ready/intermission state.</span><select data-jump-question aria-label="Jump to question">${choices}</select><button class="btn btn-secondary" data-jump-question-button>Jump to question</button></div>`;
}

function shortcutGuide() {
  return `<aside class="shortcut-guide" data-shortcut-guide hidden><div><strong>Host shortcuts</strong><button data-toggle-shortcuts aria-label="Close shortcut guide">×</button></div><p><kbd>N</kbd> Start / next question</p><p><kbd>R</kbd> Reveal and score</p><p><kbd>Space</kbd> Play audio</p><p><kbd>?</kbd> Show this guide</p></aside>`;
}

function renderLanding() {
  const catalogControl = availableQuizzes.length
    ? `<label class="field"><span>Quiz to host</span><select data-quiz-version>${availableQuizzes.map((quiz) => `<option value="${quiz.quizVersionId}">${quiz.title} · v${quiz.version}</option>`).join("")}</select></label>`
    : "";
  app.innerHTML = shell(`${brandTopbar()}<section class="landing"><div class="landing-card"><div class="landing-copy"><p class="eyebrow">Kaplan presents</p><h1>Run a great quiz, any subject.</h1><p>A host-led game platform with synchronized phones, optional live audio, and a shared scoreboard.</p>${catalogControl}<div class="landing-actions">${roomApi.configured ? '<button class="btn btn-primary" data-create-room>Create hosted room</button>' : '<a class="btn btn-primary" href="?view=host">Open host demo</a>'}<a class="btn btn-secondary" href="./author.html">Edit question bank</a></div><form class="field" data-join-by-code><label for="room-code">Joining a game?</label><input id="room-code" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="Enter room code" aria-label="Room code" /><button class="btn btn-secondary" type="submit">Join room</button></form></div><div class="landing-visual"><div class="vinyl"></div></div></div></section>`);
}

function answerButtons({player = false, presenter = false} = {}) {
  const question = player || presenter ? state.question : hostQuestion;
  if (!question.options) return "";
  return question.options.map((option, index) => {
    const multiple = question.type === "multiple_choice";
    const current = player && (multiple ? Array.isArray(selected) && selected.includes(option.id) : selected === option.id);
    const revealed = state.phase === "reveal";
    const revealedCorrectIds = player || presenter ? (state.revealedCorrectOptionIds?.length ? state.revealedCorrectOptionIds : [state.revealedCorrectOptionId]) : (hostQuestion.correctOptionIds || [correctOptionId(hostQuestion)]);
    const correct = revealed && revealedCorrectIds.includes(option.id);
    const wrong = revealed && player && current && !correct;
    const image = option.imageAssetId ? `<img class="answer-image" data-private-image="${escapeHtml(option.imageAssetId)}" alt="${escapeHtml(option.label)}" />` : "";
    return `<button class="answer ${current ? "is-selected" : ""} ${correct ? "is-correct" : ""} ${wrong ? "is-wrong" : ""}" data-answer="${option.id}" ${state.phase !== "open" && player ? "disabled" : ""}><span class="key">${String.fromCharCode(65 + index)}</span><span class="answer-content">${image}<span>${escapeHtml(option.label)}</span></span></button>`;
  }).join("");
}

function dragCard(item, kind, enabled, { assigned = false } = {}) {
  const isActiveIntro = kind === "matching" && item.id === state.activeClipId;
  return `<div class="drag-card ${enabled ? "is-draggable" : ""} ${assigned ? "is-assigned" : ""} ${isActiveIntro ? "is-playing-intro" : ""}" data-drag-item="${escapeHtml(item.id)}" data-drag-kind="${kind}" ${enabled ? 'tabindex="0" role="button" aria-label="Drag ' + escapeHtml(item.label) + '"' : ""}>${isActiveIntro ? '<span class="intro-playing-dot" aria-hidden="true">♫</span>' : '<span class="drag-handle" aria-hidden="true">⠿</span>'}<span>${escapeHtml(item.label)}</span></div>`;
}

function selectedObject() {
  return selected && typeof selected === "object" && !Array.isArray(selected) ? selected : {};
}

function orderedItems(question, positions = selectedObject()) {
  return [...(question.items || [])].sort((left, right) => (Number(positions[left.id]) || 999) - (Number(positions[right.id]) || 999));
}

function orderBoard(question, player, presenter = false) {
  const enabled = player && state.phase === "open";
  const showingCorrectOrder = !presenter || state.phase === "reveal";
  const items = orderedItems(question, player ? selectedObject() : showingCorrectOrder ? Object.fromEntries((question.correctOrder || []).map((id, index) => [id, index + 1])) : Object.fromEntries((question.items || []).map((item, index) => [item.id, index + 1])));
  return `<div class="drag-board" data-drag-board="order"><p class="drag-help">${enabled ? "Drag cards into the order you think is right." : showingCorrectOrder ? "Correct order" : "Put these in order on your phone."}</p><div class="drag-sort-list" data-drop-zone="order">${items.map((item, index) => `<div class="drag-order-row"><span class="drag-position">${showingCorrectOrder ? index + 1 : "•"}</span>${dragCard(item, "order", enabled)}</div>`).join("")}</div></div>`;
}

function matchingBoard(question, player, presenter = false) {
  const enabled = player && state.phase === "open";
  const showingMatches = !presenter || state.phase === "reveal";
  const assignments = player ? selectedObject() : showingMatches ? question.correctPairs || {} : {};
  const hasTargetImages = (question.options || []).some((option) => option.imageAssetId);
  const assignedClipIds = new Set(Object.keys(assignments).filter((clipId) => assignments[clipId]));
  const unassigned = (question.clips || []).filter((clip) => !assignedClipIds.has(clip.id));
  const helper = enabled ? (hasTargetImages ? "Drag each song title onto its matching movie poster." : "Match each item to a choice.") : showingMatches ? "Correct matches" : "Listen carefully—matches will be revealed shortly.";
  const activeClipIndex = (question.clips || []).findIndex((clip) => clip.id === state.activeClipId);
  return `<div class="drag-board ${hasTargetImages ? "" : "matching-board--text-only"} ${showingMatches ? "" : "matching-board--concealed"}" data-drag-board="matching"><p class="drag-help">${helper}</p><div class="drag-pool" data-drop-zone="matching-pool">${unassigned.length && !presenter ? unassigned.map((clip) => dragCard(clip, "matching", enabled)).join("") : '<span class="drag-empty">${showingMatches ? "All items placed" : "Listen for each clip"}</span>'}</div><div class="drag-slots">${(question.options || []).map((option, index) => { const clip = (question.clips || []).find((entry) => assignments[entry.id] === option.id); const isActiveIntro = presenter && !showingMatches && index === activeClipIndex; const targetImage = hasTargetImages ? (option.imageAssetId ? `<img class="matching-target-image" data-private-image="${escapeHtml(option.imageAssetId)}" alt="${escapeHtml(option.label)} poster" />` : '<span class="matching-target-fallback">Image unavailable</span>') : ""; const label = showingMatches || hasTargetImages ? escapeHtml(option.label) : "?"; return `<div class="drag-slot matching-target-slot ${isActiveIntro ? "is-playing-intro" : ""}" data-drop-zone="matching-slot" data-option-id="${escapeHtml(option.id)}"><div class="matching-target">${targetImage}<span class="drag-slot-label">${label}</span></div>${clip ? dragCard(clip, "matching", enabled, { assigned: true }) : `<span class="drag-placeholder">${isActiveIntro ? '<span class="intro-playing-dot" aria-hidden="true">♫</span> Now playing' : showingMatches ? "No match yet" : "Listen closely"}</span>`}</div>`; }).join("")}</div></div>`;
}

function matchingSelectBoard(question) {
  const enabled = state.phase === "open";
  const assignments = selectedObject();
  const usedOptionIds = new Set(Object.values(assignments).filter(Boolean));
  return `<div class="matching-select-board"><p class="drag-help">Choose one title for each sample. A title can only be used once.</p>${(question.clips || []).map((clip) => `<label class="matching-select-row"><strong>${escapeHtml(clip.label)}</strong><select data-match-select="${escapeHtml(clip.id)}" ${enabled ? "" : "disabled"}><option value="">Choose a title</option>${(question.options || []).map((option) => `<option value="${escapeHtml(option.id)}" ${assignments[clip.id] === option.id ? "selected" : ""} ${usedOptionIds.has(option.id) && assignments[clip.id] !== option.id ? "disabled" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`).join("")}</div>`;
}

function categorizeBoard(question, player) {
  const enabled = player && state.phase === "open";
  const assignments = player ? selectedObject() : question.correctCategories || {};
  const assignedItemIds = new Set(Object.keys(assignments).filter((id) => assignments[id]));
  const unassigned = (question.items || []).filter((item) => !assignedItemIds.has(item.id));
  return `<div class="drag-board" data-drag-board="categorize"><p class="drag-help">${enabled ? "Drag each card into one of the two categories." : "Correct categories"}</p><div class="drag-pool" data-drop-zone="categorize-pool">${unassigned.length ? unassigned.map((item) => dragCard(item, "categorize", enabled)).join("") : '<span class="drag-empty">All cards sorted</span>'}</div><div class="drag-buckets">${(question.categories || []).map((category) => `<section class="drag-bucket" data-drop-zone="categorize-bucket" data-category-id="${escapeHtml(category.id)}"><h3>${escapeHtml(category.label)}</h3><div>${(question.items || []).filter((item) => assignments[item.id] === category.id).map((item) => dragCard(item, "categorize", enabled, { assigned: true })).join("") || '<span class="drag-placeholder">Drop cards here</span>'}</div></section>`).join("")}</div></div>`;
}

function categorizeTapBoard(question) {
  const enabled = state.phase === "open";
  const assignments = selectedObject();
  return `<div class="categorize-tap-board"><p class="drag-help">Tap a category for each item.</p><div class="categorize-key">${(question.categories || []).map((category) => `<span>${escapeHtml(category.label)}</span>`).join("")}</div>${(question.items || []).map((item) => `<section class="categorize-tap-row"><strong>${escapeHtml(item.label)}</strong><div>${(question.categories || []).map((category) => `<button type="button" data-categorize-item="${escapeHtml(item.id)}" data-category-id="${escapeHtml(category.id)}" class="${assignments[item.id] === category.id ? "is-selected" : ""}" ${enabled ? "" : "disabled"}>${escapeHtml(category.label)}</button>`).join("")}</div></section>`).join("")}</div>`;
}

function anonymousTextAnswerWall() {
  if (!['locked', 'reveal'].includes(state.phase)) return '<p class="anonymous-answer-pending">Typed answers will appear anonymously once the host locks the question.</p>';
  if (!anonymousTextAnswers.length) return '<p class="anonymous-answer-pending">No typed answers were submitted.</p>';
  return `<section class="anonymous-answer-wall" aria-label="Anonymous player answers"><p class="eyebrow">Anonymous answers</p><div>${anonymousTextAnswers.map((answer) => `<span>${escapeHtml(answer)}</span>`).join("")}</div></section>`;
}

function answerControl({ player = false, presenter = false } = {}) {
  const question = player || presenter ? state.question : hostQuestion;
  if (["single_choice", "multiple_choice", "true_false", "image_selection"].includes(question.type)) return `<div class="answer-grid">${answerButtons({ player, presenter })}</div>`;
  if (["short_answer", "fill_in_the_blank", "numeric_estimate", "closest_number"].includes(question.type)) {
    if (presenter && ["short_answer", "fill_in_the_blank"].includes(question.type)) return anonymousTextAnswerWall();
    const isNumber = ["numeric_estimate", "closest_number"].includes(question.type);
    const revealedNumber = player || presenter ? state.revealedNumber : hostQuestion.targetNumber;
    const reveal = question.type === "closest_number" && state.phase === "reveal" && Number.isFinite(Number(revealedNumber)) ? `<p class="number-reveal">Correct number: <strong>${escapeHtml(revealedNumber)}</strong></p>` : "";
    return `<div class="player-answers"><label class="field"><span>${isNumber ? question.type === "closest_number" ? "Your closest guess" : "Your estimate" : "Your answer"}</span><input data-text-answer ${isNumber ? 'type="number" inputmode="decimal" step="any"' : ""} ${player && state.phase === "open" ? "" : "disabled"} value="${typeof selected === "string" ? selected : ""}" placeholder="${isNumber ? "Enter a number" : "Type your answer"}" /></label>${question.type === "closest_number" ? '<p class="closest-number-help">Closest valid guess wins. Tied closest guesses split the points.</p>' : ""}${reveal}</div>`;
  }
  if (question.type === "categorize") return player ? categorizeTapBoard(question) : categorizeBoard(question, player);
  if (question.type === "arrange_in_order") return orderBoard(question, player, presenter);
  if (question.type === "matching") return player ? matchingSelectBoard(question) : matchingBoard(question, player, presenter);
  return "<p>This question type is ready for the host but has no player control yet.</p>";
}

async function refreshAnonymousTextAnswers() {
  if (view !== "presenter" || !params.has("room") || !['short_answer', 'fill_in_the_blank'].includes(state.question?.type) || !['locked', 'reveal'].includes(state.phase)) {
    anonymousTextAnswers = [];
    anonymousTextAnswersKey = "";
    anonymousTextAnswerRetries = 0;
    return;
  }
  const hostSecret = getHostSecret();
  if (!hostSecret) return;
  const key = `${roomCode}:${state.questionId || state.question?.id}:${state.phase}:${state.revision || ""}`;
  if (key === anonymousTextAnswersKey || key === anonymousTextAnswersPendingKey) return;
  anonymousTextAnswersPendingKey = key;
  try {
    const response = await fetch(`${quizWorkerOrigin}/host-text-answers`, { headers: { "x-quiz-room": roomCode, "x-quiz-host-secret": hostSecret } });
    if (!response.ok) throw new Error(`Answer wall request failed (${response.status})`);
    const result = await response.json();
    if (anonymousTextAnswersPendingKey !== key) return;
    anonymousTextAnswers = Array.isArray(result.answers) ? result.answers : [];
    anonymousTextAnswersKey = key;
    if (anonymousTextAnswers.length) anonymousTextAnswerRetries = 0;
    render();
    if (!anonymousTextAnswers.length && anonymousTextAnswerRetries < 3) {
      anonymousTextAnswerRetries += 1;
      setTimeout(() => {
        if (anonymousTextAnswersKey !== key || !["locked", "reveal"].includes(state.phase)) return;
        anonymousTextAnswersKey = "";
        refreshAnonymousTextAnswers();
      }, 350 * anonymousTextAnswerRetries);
    }
  } catch (error) {
    recordDiagnostic("anonymous-answer-wall", error, { roomCode, questionId: state.questionId });
    console.warn("Could not load anonymous text answers.", error);
  } finally {
    if (anonymousTextAnswersPendingKey === key) anonymousTextAnswersPendingKey = "";
  }
}

function revealImage({ player = false, presenter = false } = {}) {
  if (state.phase !== "reveal") return "";
  const assetId = player || presenter ? state.revealImageAssetId : hostQuestion.revealImageAssetId;
  if (!assetId) return "";
  return `<figure class="reveal-image"><img data-private-image="${escapeHtml(assetId)}" alt="Answer reveal image" />${presenter ? "" : "<figcaption>Answer reveal</figcaption>"}</figure>`;
}

function questionImage({ player = false, presenter = false } = {}) {
  const question = player || presenter ? state.question : hostQuestion;
  if (state.phase === "reveal" && (player || presenter ? state.revealImageAssetId : hostQuestion.revealImageAssetId)) return "";
  const assetId = question?.questionImageAssetId;
  if (!assetId) return "";
  return `<figure class="question-image"><img data-private-image="${escapeHtml(assetId)}" alt="Question image" />${presenter ? "" : "<figcaption>Question image</figcaption>"}</figure>`;
}

function answerReady(question = state.question) {
  if (["multiple_choice"].includes(question.type)) return Array.isArray(selected) && selected.length > 0;
  if (["short_answer", "fill_in_the_blank", "numeric_estimate"].includes(question.type)) return typeof selected === "string" && selected.trim().length > 0;
  if (question.type === "closest_number") return typeof selected === "string" && validNumericGuess(selected);
  if (question.type === "arrange_in_order") return (question.items || []).every((item) => selected?.[item.id]);
  if (question.type === "categorize") return (question.items || []).every((item) => selected?.[item.id]);
  if (question.type === "matching") return (question.clips || []).every((clip) => selected?.[clip.id]);
  return typeof selected === "string";
}

function audioPanel(sourceAudio = null, { opening = false } = {}) {
  const audio = sourceAudio || hostQuestion.audio || (hostQuestion.audioLabel ? { suggestedWindow: hostQuestion.audioLabel, cue: hostQuestion.audioHelp } : null);
  if (!audio) return "";
  const playable = Boolean(hostQuizDefinition && params.has("room") && (audio.mediaAssetId || audio.url));
  const scope = opening ? "title" : "question";
  const controls = playable ? `<div class="host-audio-actions"><button class="btn btn-primary" data-audio-command="play" data-audio-scope="${scope}">Play clip</button><button class="btn btn-secondary" data-audio-command="restart" data-audio-scope="${scope}">Restart</button><button class="btn btn-secondary" data-audio-command="pause" data-audio-scope="${scope}">Pause</button></div>` : "";
  return `<div class="audio-panel audio-panel--host"><span class="audio-play is-external" aria-hidden="true">♫</span><div class="audio-copy"><strong>${escapeHtml(audio.suggestedWindow || (opening ? "Waiting-room music" : hostQuestion.audioLabel) || "Audio clip")}</strong><span>${playable ? "Plays through the presentation tab when you cue it here." : escapeHtml(audio.cue || "Attach an uploaded clip in authoring to enable host controls.")}</span></div>${controls}</div>`;
}

function matchingClipControls() {
  if (hostQuestion.type !== "matching" || !(hostQuestion.clips || []).some((clip) => clip.mediaAssetId || clip.url)) return "";
  return `<section class="matching-clip-controls"><div><strong>Intro playback</strong><span>Choose an intro to play it and spotlight its tile in Presentation.</span></div><div>${hostQuestion.clips.map((clip) => `<button class="btn ${clip.id === state.activeClipId ? "btn-primary" : "btn-secondary"}" data-play-intro="${escapeHtml(clip.id)}">${escapeHtml(clip.label)}</button>`).join("")}</div></section>`;
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

async function loadPrivateHostAudio(player, assetId = hostQuestion.audio?.mediaAssetId) {
  const hostSecret = getHostSecret();
  if (!assetId || !hostSecret || !params.has("room") || loadedPrivateAudioAssetId === assetId) return;
  const response = await fetch(`/media/${encodeURIComponent(assetId)}`, { headers: { "x-quiz-room": roomCode, "x-quiz-host-secret": hostSecret } });
  if (!response.ok) {
    const stage = response.headers.get("x-quiz-media-stage");
    const upstreamStatus = response.headers.get("x-quiz-upstream-status");
    throw new Error(`Private media could not be loaded${stage ? ` (${stage}${upstreamStatus ? ` ${upstreamStatus}` : ""})` : ""}`);
  }
  if (hostMediaObjectUrl) URL.revokeObjectURL(hostMediaObjectUrl);
  hostMediaObjectUrl = URL.createObjectURL(await response.blob());
  player.src = hostMediaObjectUrl;
  player.load();
  loadedPrivateAudioAssetId = assetId;
}

function questionDefinitionById(questionId) {
  if (!questionId) return null;
  for (const round of hostQuizDefinition?.rounds || []) {
    const found = (round.questions || []).find((question) => question.id === questionId);
    if (found) return found;
  }
  return null;
}

async function preparePresentationAudio(command = state.audioCommand) {
  if (view !== "presenter" || !presentationAudioPlayer) return;
  const commandedQuestion = questionDefinitionById(command?.questionId);
  const commandedIntro = command?.clipId ? commandedQuestion?.clips?.find((clip) => clip.id === command.clipId) : null;
  const audio = command?.audioScope === "title"
    ? hostQuizDefinition?.titlePage?.audio
    : commandedIntro || commandedQuestion?.audio || (state.presentationScreen === "title" ? hostQuizDefinition?.titlePage?.audio : hostQuestion.audio);
  const sourceKey = audio?.mediaAssetId || audio?.url || null;
  if (!sourceKey || sourceKey === presentationAudioSourceKey) return;
  presentationAudioPlayer.pause();
  presentationAudioPlayer.removeAttribute("src");
  presentationAudioPlayer.load();
  loadedPrivateAudioAssetId = null;
  if (audio.url) {
    presentationAudioPlayer.src = audio.url;
    presentationAudioPlayer.load();
    presentationAudioSourceKey = sourceKey;
    return;
  }
  await loadPrivateHostAudio(presentationAudioPlayer, audio.mediaAssetId);
  if (presentationAudioPlayer.src) presentationAudioSourceKey = sourceKey;
}

async function armPresentationAudio() {
  await preparePresentationAudio();
  const usedSilentPrimer = !presentationAudioPlayer?.src;
  if (usedSilentPrimer) {
    presentationAudioPlayer.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    presentationAudioPlayer.load();
  }
  presentationAudioPlayer.volume = 0;
  await presentationAudioPlayer.play();
  presentationAudioPlayer.pause();
  presentationAudioPlayer.currentTime = 0;
  presentationAudioPlayer.volume = 1;
  if (usedSilentPrimer) {
    presentationAudioPlayer.removeAttribute("src");
    presentationAudioPlayer.load();
    presentationAudioSourceKey = null;
  }
  presentationAudioArmed = true;
  // If a play command arrived before the one-time browser gesture, apply it
  // immediately after arming instead of making the host click Play again.
  handledPresentationAudioCommand = null;
  render();
}

async function startPresentationPlayback() {
  try {
    await presentationAudioPlayer.play();
  } catch (firstError) {
    // A newly assigned Blob/remote source can still be buffering when the
    // first host cue reaches this tab. Retry as soon as it is playable so the
    // host does not need to press Play a second time.
    await new Promise((resolve) => {
      const ready = () => { clearTimeout(timeout); resolve(); };
      const timeout = setTimeout(ready, 1200);
      presentationAudioPlayer.addEventListener("canplay", ready, { once: true });
    });
    await presentationAudioPlayer.play();
  }
}

async function applyPresentationAudioCommand() {
  const command = state.audioCommand;
  if (view !== "presenter" || !presentationAudioPlayer || !presentationAudioArmed || !command?.id || command.id === handledPresentationAudioCommand) return;
  await preparePresentationAudio(command);
  handledPresentationAudioCommand = command.id;
  if (command.action === "pause") { presentationAudioPlayer.pause(); return; }
  if (command.action === "restart") presentationAudioPlayer.currentTime = 0;
  try { await startPresentationPlayback(); } catch (error) { console.warn("Presentation audio needs to be enabled once in the presentation tab.", error); }
}

async function loadPrivateImage(image) {
  const assetId = image.dataset.privateImage;
  if (!assetId || !params.has("room")) return;
  const hostSecret = getHostSecret();
  const headers = { "x-quiz-room": roomCode };
  if (["host", "presenter"].includes(view) && hostSecret) headers["x-quiz-host-secret"] = hostSecret;
  else headers["x-quiz-player-token"] = playerId;
  const response = await fetch(`/media/${encodeURIComponent(assetId)}`, { headers });
  if (!response.ok) throw new Error("Private image could not be loaded");
  const objectUrl = URL.createObjectURL(await response.blob());
  imageMediaObjectUrls.push(objectUrl);
  image.src = objectUrl;
}

function leaderboard() {
  const players = [...state.players].sort((a, b) => Number(b.points) - Number(a.points) || String(a.name).localeCompare(String(b.name)));
  return `<section class="leaderboard-card"><h3>Current leaderboard</h3><div class="leaderboard">${players.map((p, i) => `<div class="leader"><span class="place">${i + 1}</span>${playerLogoMarkup(p, "player-logo--host")}<span><b>${escapeHtml(p.name)}</b><br/><small>${i === 0 ? "Holding the lead" : "In the mix"}</small></span><b>${Number(p.points) || 0}</b></div>`).join("")}</div></section>`;
}

function manualScoreControls() {
  if (view !== "host") return "";
  const isHosted = params.has("room");
  const canAdjust = isHosted && state.players.length > 0;
  const note = !isHosted ? "Create or load a hosted room to award points." : !state.players.length ? "This appears ready once at least one player has joined." : "Awards appear as a celebration in Presentation.";
  return `<div class="manual-score"><strong>Manual score adjustment</strong><span>${note}</span><select data-score-player aria-label="Player" ${canAdjust ? "" : "disabled"}><option value="">Choose player</option>${state.players.map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`).join("")}</select><input data-score-points type="number" step="0.5" placeholder="+/- points" aria-label="Points to add or subtract" ${canAdjust ? "" : "disabled"} /><input data-score-reason maxlength="120" placeholder="Reason (optional)" aria-label="Adjustment reason" ${canAdjust ? "" : "disabled"} /><button class="btn btn-secondary" data-adjust-score ${canAdjust ? "" : "disabled"}>Apply adjustment</button></div>`;
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function resultsCsv(players) {
  const sorted = [...players].sort((a, b) => Number(b.points) - Number(a.points) || String(a.name).localeCompare(String(b.name)));
  let priorPoints = null;
  let rank = 0;
  const rows = sorted.map((player, index) => {
    if (priorPoints === null || Number(player.points) !== priorPoints) rank = index + 1;
    priorPoints = Number(player.points);
    return [rank, player.name, player.points].map(csvCell).join(",");
  });
  return [["Rank", "Display name", "Points"].map(csvCell).join(","), ...rows].join("\n") + "\n";
}

function exportResults() {
  const blob = new Blob([resultsCsv(state.players)], { type: "text/csv;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${(hostQuizDefinition?.title || "quiz-results").replace(/[^a-z0-9-]/gi, "-")}-${roomCode}-results.csv` });
  link.click();
  URL.revokeObjectURL(link.href);
}

async function exportDetailedResults() {
  const hostSecret = getHostSecret();
  if (!hostSecret || !params.has("room")) { alert("Detailed results are available for hosted rooms only."); return; }
  try {
    const events = await roomApi.getHostScoreEvents({ roomCode, hostSecret });
    const header = ["Display name", "Question ID", "Base points", "Multiplier", "Points", "Reason", "Recorded at"].map(csvCell).join(",");
    const rows = events.map((event) => [event.displayName, event.questionId, event.basePoints ?? "", event.multiplier ?? "", event.points, event.reason, event.createdAt].map(csvCell).join(","));
    const blob = new Blob([[header, ...rows].join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${(hostQuizDefinition?.title || "quiz-results").replace(/[^a-z0-9-]/gi, "-")}-${roomCode}-score-events.csv` });
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) { alert(`Could not export detailed results: ${error.message}`); }
}

const doorIconSymbol = (icon) => ({ shield: "◆", dice: "⚄", lightning: "ϟ", star: "★", key: "⚿", flame: "♦" })[icon] || "◆";
const formatMultiplier = (value) => `${Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}×`;
function doorOdds(door) {
  return (door?.outcomes || []).map((outcome) => `${Number(outcome.chancePercent)}% ${formatMultiplier(outcome.multiplier)}`).join(" · ");
}
function activePlayerDoorResult() {
  return (state.doorResults || []).find((entry) => entry.playerId === playerId) || null;
}
function activeMultiplierBadge() {
  const result = activePlayerDoorResult();
  const currentRoundIndex = Math.max(0, Number(state.question?.round || 1) - 1);
  if (!result || Number(state.targetRoundIndex) !== currentRoundIndex || ["door_choice", "door_reveal", "complete"].includes(state.phase)) return "";
  return `<span class="active-multiplier ${Number(result.multiplier) < 1 ? "is-penalty" : ""}">${formatMultiplier(result.multiplier)} this round</span>`;
}
function doorChoiceCards({ interactive = false, compact = false } = {}) {
  const config = doorBonusDefinition();
  const entries = state.phase === "door_reveal" ? (state.doorResults || []) : (state.doorPicks || []);
  const selectedDoorId = (state.doorPicks || []).find((entry) => entry.playerId === playerId)?.doorId;
  return `<div class="door-grid ${compact ? "door-grid--compact" : ""}">${(config?.doors || []).map((door, doorIndex) => {
    const players = entries.filter((entry) => entry.doorId === door.id);
    const people = interactive ? "" : players.length ? `<div class="door-players">${players.map((entry, index) => `<span class="door-player ${state.phase === "door_reveal" ? Number(entry.multiplier) < 1 ? "is-penalty" : "is-boost" : ""}" style="--door-player-delay:${index * .06}s">${playerLogoMarkup({ logoKey: entry.logoKey }, "player-logo--door")}<b>${escapeHtml(entry.playerName)}</b>${state.phase === "door_reveal" ? `<strong>${formatMultiplier(entry.multiplier)}</strong>` : ""}</span>`).join("")}</div>` : `<p class="door-empty">No picks yet</p>`;
    const content = `<span class="door-number">Door ${doorIndex + 1}</span><span class="door-icon door-icon--${escapeHtml(door.icon)}" aria-hidden="true">${doorIconSymbol(door.icon)}</span><h3>${escapeHtml(door.name)}</h3><p class="door-odds">${escapeHtml(doorOdds(door))}</p>${people}`;
    return interactive ? `<button class="door-card ${selectedDoorId === door.id ? "is-selected" : ""}" data-choose-door="${escapeHtml(door.id)}" type="button" ${state.phase !== "door_choice" ? "disabled" : ""}>${content}<span class="door-select-label">${selectedDoorId === door.id ? "Your pick" : "Choose this door"}</span></button>` : `<article class="door-card">${content}</article>`;
  }).join("")}</div>`;
}

function renderHostDoors() {
  const picked = (state.doorPicks || []).length;
  const targetRound = hostQuizDefinition?.rounds?.[state.targetRoundIndex];
  const revealed = state.phase === "door_reveal";
  app.innerHTML = shell(`${brandTopbar(true)}<main class="host-layout host-layout--doors"><div class="game-meta"><span><strong>${escapeHtml(hostQuizDefinition?.title || "Quiz night")}</strong> · Room ${escapeHtml(roomCode)}</span><span>Round ${Number(state.targetRoundIndex) + 1} next</span></div><section class="round-panel"><span class="round-number">Between rounds</span><h1>${revealed ? "The doors are open." : "Choose your door."}</h1><p>${revealed ? `Rewards apply throughout ${escapeHtml(targetRound?.title || "the next round")}.` : `Players are choosing a multiplier for ${escapeHtml(targetRound?.title || "the next round")}.`}</p></section><div class="game-grid game-grid--doors"><section class="question-card door-host-board"><p class="eyebrow">${revealed ? "Rewards revealed" : `${picked} of ${state.players.length} picked`}</p>${doorChoiceCards({ compact: true })}</section><aside class="host-panel"><h3>Session control</h3><div class="stat"><strong>${picked}<span> / ${state.players.length}</span></strong><span>doors chosen</span></div><div class="host-actions">${revealed ? '<button class="btn btn-primary" data-next>Continue to next round <span class="keyhint">N</span></button>' : '<button class="btn btn-primary" data-reveal-doors>Reveal rewards <span class="keyhint">R</span></button>'}<button class="btn btn-secondary" data-download-diagnostics>Download diagnostics</button></div>${leaderboard()}</aside></div></main>${shortcutGuide()}`);
}

function renderHost() {
  if (["door_choice", "door_reveal"].includes(state.phase)) { renderHostDoors(); return; }
  const submittedCount = Object.keys(state.submitted).length;
  const playerUrl = `${location.origin}${location.pathname}?view=player&room=${encodeURIComponent(roomCode)}`;
  const presentationUrl = `${location.origin}${location.pathname}?view=presenter&room=${encodeURIComponent(roomCode)}`;
  const demoNotice = !isHostedRoom ? '<div class="host-demo-notice"><strong>Local demo — not a published room.</strong><span>This screen uses sample questions and cannot load your uploaded assets.</span><a class="btn btn-secondary" href="./index.html">Create a hosted room</a></div>' : "";
  const openingTitle = hostQuizDefinition?.titlePage;
  const openingAudio = state.presentationScreen === "title" ? audioPanel(openingTitle?.audio, { opening: true }) : "";
  const hostedLobby = isHostedRoom && state.presentationScreen === "title" ? `<div class="preview-note"><strong>Share the presentation tab in Google Meet. App-hosted clips can play there; for an external prepared source, share system audio instead.</strong></div>${preflightChecklist()}<div class="join-qr"><canvas data-join-qr aria-label="Player join QR code"></canvas><span>Scan to join</span></div><div class="field"><label>Player join link</label><input readonly value="${playerUrl}" aria-label="Player join link" /><button class="btn btn-secondary" data-copy-link>Copy link</button></div>` : "";
  const presentationAction = isHostedRoom ? `<a class="btn btn-secondary" href="${presentationUrl}" target="_blank" rel="noopener">Open presentation view</a>` : "";
  app.innerHTML = shell(`${brandTopbar(true)}<main class="host-layout"><div class="game-meta"><span><strong>${hostQuizDefinition?.title || "Quiz night"}</strong> · ${isHostedRoom ? `Room ${roomCode}` : "Local demo"}</span>${roundProgress()}</div>${demoNotice}<section class="round-panel"><span class="round-number">${state.presentationScreen === "title" ? "Opening title page" : state.phase === "complete" ? "Final standings" : `Round ${state.question.round || 1} of ${hostQuizDefinition?.rounds?.length || 5}`}</span><h1>${state.presentationScreen === "title" ? (hostQuizDefinition?.title || "Quiz night") : state.phase === "complete" ? "That’s the game." : state.question.roundTitle}</h1><p>${state.presentationScreen === "title" ? "The presentation is on its opening page. Cue waiting-room music here, then start when everyone is ready." : state.phase === "lobby" ? "Players are joining. Start when you are ready." : state.phase === "reveal" ? "Answer revealed. Celebrate the recognition, then move on." : state.phase === "complete" ? "Final scores are in—congratulations to the podium." : "Listen closely—your players are answering on their phones."}</p></section><div class="game-grid"><section class="question-card"><p class="eyebrow">${state.presentationScreen === "title" ? "Waiting room" : state.phase === "complete" ? "Final leaderboard" : state.phase === "lobby" ? "Lobby" : state.phase === "reveal" ? "Answer reveal" : `Question ${state.question.questionInRound || 1} of ${state.question.questionsInRound || 5}`}</p><h2>${state.presentationScreen === "title" ? "Your title page is live in Presentation." : state.phase === "complete" ? "Thanks for playing." : state.question.prompt}</h2>${state.phase === "complete" ? leaderboard() : `${openingAudio}${state.presentationScreen === "title" ? "" : `${audioPanel()}${matchingClipControls()}${answerControl()}${revealImage()}`}`}</section><aside class="host-panel"><h3>Session control</h3><div class="stat"><strong>${submittedCount}<span> / ${state.players.length}</span></strong><span>answers received</span></div>${hostedLobby}<div class="host-actions">${presentationAction}${state.phase === "lobby" ? '<button class="btn btn-primary" data-phase="open">Start question <span class="keyhint">N</span></button>' : state.phase === "open" || state.phase === "locked" ? '<button class="btn btn-primary" data-reveal-question>Reveal answer <span class="keyhint">R</span></button>' : state.phase === "complete" ? '<button class="btn btn-secondary" data-export-results>Download standings CSV</button><button class="btn btn-secondary" data-export-detailed-results>Download score events CSV</button>' : hostQuizDefinition ? '<button class="btn btn-primary" data-next>Next question <span class="keyhint">N</span></button>' : '<button class="btn btn-primary" data-reset>Reset demo <span class="keyhint">↺</span></button>'}<button class="btn btn-secondary" data-player>Add demo player</button><button class="btn btn-secondary" data-download-diagnostics>Download diagnostics</button></div>${hostUtilityControls()}${timerControls()}${manualScoreControls()}${questionJumpControls()}${state.phase === "complete" ? "" : leaderboard()}</aside></div></main>${shortcutGuide()}`);
}

function scoreCelebration() {
  const note = state.scoreNotification;
  if (!note?.expiresAt || new Date(note.expiresAt).getTime() <= Date.now()) return "";
  const points = Number(note.points) || 0;
  return `<aside class="score-celebration ${points < 0 ? "is-deduction" : ""}" role="status" aria-live="polite"><span aria-hidden="true">${points < 0 ? "✦" : "★"}</span><div><strong>${escapeHtml(note.playerName)} ${points > 0 ? "+" : ""}${escapeHtml(points)} points</strong><p>${escapeHtml(note.reason || "Host award")}</p></div></aside>`;
}

function presentationLeaderboard({ final = false } = {}) {
  const players = [...state.players].sort((a, b) => Number(b.points) - Number(a.points) || String(a.name).localeCompare(String(b.name)));
  if (!players.length) return `<section class="presentation-leaderboard-card is-empty"><p class="eyebrow">${final ? "Final standings" : "Scoreboard"}</p><h2>${final ? "The final scores are on their way." : "The scoreboard will appear as players join."}</h2></section>`;
  let previousPoints = null;
  let rank = 0;
  const visiblePlayers = players.slice(0, final ? 10 : 5);
  const rows = visiblePlayers.map((player, index) => {
    const points = Number(player.points) || 0;
    if (previousPoints === null || points !== previousPoints) rank = index + 1;
    previousPoints = points;
    const medal = rank === 1 ? "★" : rank === 2 ? "◆" : rank === 3 ? "●" : String(rank);
    return `<li class="presentation-leader presentation-leader--${rank <= 3 ? rank : "other"}" style="--leader-delay:${0.12 + index * 0.07}s"><span class="presentation-place">${medal}</span>${playerLogoMarkup(player, "player-logo--presentation")}<strong>${escapeHtml(player.name)}</strong><span class="presentation-points">${points} <small>pts</small></span></li>`;
  }).join("");
  const remaining = players.length - visiblePlayers.length;
  return `<section class="presentation-leaderboard-card ${final ? "is-final" : ""}"><div class="presentation-leaderboard-heading"><div><p class="eyebrow">${final ? "Final standings" : "Live scoreboard"}</p><h2>${final ? "And the winner is…" : "Top of the board"}</h2></div><span>${players.length} player${players.length === 1 ? "" : "s"}</span></div><ol class="presentation-leaderboard">${rows}</ol>${remaining > 0 ? `<p class="presentation-more-players">+ ${remaining} more player${remaining === 1 ? "" : "s"}</p>` : ""}</section>`;
}

function presenterIntermission() {
  const questionNumber = Number(state.question?.questionInRound) || 1;
  const totalQuestions = Number(state.question?.questionsInRound) || 1;
  const roundNumber = Number(state.question?.round) || 1;
  const totalRounds = Number(state.question?.totalRounds) || 1;
  return `<section class="presentation-card presentation-card--intermission"><div class="presentation-intermission-copy"><p class="eyebrow">${questionNumber === 1 ? "Next round" : "Up next"}</p><h2>${questionNumber === 1 ? "A new round is about to begin." : `Question ${questionNumber} of ${totalQuestions} is ready.`}</h2><p>Round ${roundNumber} of ${totalRounds} · The host will start when everyone is set.</p></div>${presentationLeaderboard()}</section>`;
}

function presentationTitlePage() {
  const titlePage = hostQuizDefinition?.titlePage || {};
  const title = hostQuizDefinition?.title || "Quiz night";
  const subtitle = titlePage.subtitle || "Get your phone ready — we’ll begin shortly.";
  const musicLogo = '<span class="presentation-title-music-logo" aria-hidden="true">♫</span>';
  const themeArt = titlePage.imageAssetId
    ? `<div class="presentation-title-art-with-logo"><img class="presentation-title-art" data-private-image="${escapeHtml(titlePage.imageAssetId)}" alt="${escapeHtml(titlePage.imageAlt || "Quiz theme artwork")}" />${musicLogo}</div>`
    : musicLogo;
  const playerCount = state.players.length;
  return `<section class="presentation-title-page"><div class="presentation-title-copy"><p class="eyebrow">Kaplan presents</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><div class="presentation-title-join"><canvas data-join-qr aria-label="QR code to join this quiz"></canvas><div><strong>Join the quiz</strong><span>Scan the code with your phone</span><b>${escapeHtml(roomCode)}</b><em>${playerCount} player${playerCount === 1 ? "" : "s"} waiting to play</em></div></div></div><div class="presentation-title-art-wrap">${themeArt}</div><span class="presentation-title-orb presentation-title-orb--one" aria-hidden="true"></span><span class="presentation-title-orb presentation-title-orb--two" aria-hidden="true"></span></section>`;
}

function renderPresenter() {
  const phaseLabel = state.phase === "lobby" ? "Get ready" : state.phase === "open" ? "Question" : state.phase === "locked" ? "Answers locked" : state.phase === "reveal" ? "Answer reveal" : state.phase === "door_choice" ? "Choose your door" : state.phase === "door_reveal" ? "Rewards revealed" : "Final standings";
  const questionNumber = Number(state.question?.questionInRound) || 1;
  const quizHasAudio = Boolean(hostQuizDefinition?.titlePage?.audio?.mediaAssetId || hostQuizDefinition?.titlePage?.audio?.url || hostQuizDefinition?.rounds?.some((round) => round.questions?.some((question) => question.audio?.mediaAssetId || question.audio?.url)));
  const soundGate = isHostedRoom && quizHasAudio && !presentationAudioArmed ? '<aside class="presentation-sound-gate"><div><p class="eyebrow">One-time setup</p><h2>Enable presentation sound</h2><p>Click once before sharing this tab. The setup disappears; all playback controls remain in Host view.</p><button class="btn btn-primary" data-arm-presentation-audio>Enable sound</button><span data-arm-audio-status role="status"></span></div></aside>' : "";
  const card = state.presentationScreen === "title"
    ? presentationTitlePage()
    : ["door_choice", "door_reveal"].includes(state.phase)
    ? `<section class="presentation-card presentation-card--doors presentation-card--${state.phase}" aria-live="polite"><div class="presentation-door-heading"><p class="eyebrow">${state.phase === "door_reveal" ? "The doors are open" : "Pick on your phone"}</p><h2>${state.phase === "door_reveal" ? "Here are your next-round multipliers." : "Which door will you choose?"}</h2></div>${doorChoiceCards()}</section>`
    : state.phase === "complete"
    ? `<section class="presentation-card presentation-card--final"><div class="winner-confetti" aria-hidden="true">${Array.from({ length: 28 }, (_, index) => `<i style="--confetti-index:${index}"></i>`).join("")}</div><p class="eyebrow">Final leaderboard</p><h2>Thanks for playing.</h2>${presentationLeaderboard({ final: true })}</section>`
    : state.phase === "lobby"
      ? presenterIntermission()
    : `<section class="presentation-card presentation-card--question presentation-card--${state.phase} presentation-card--${escapeHtml(state.question?.type || "question")} ${(state.revealImageAssetId || state.question?.questionImageAssetId) ? "presentation-card--with-side-image" : ""}" aria-live="polite">${state.phase === "reveal" ? "" : `<p class="eyebrow">${state.phase === "locked" ? "Answers are in" : `Question ${questionNumber}`}</p>`}<h2>${escapeHtml(state.question?.prompt || "Waiting for the host to start…")}</h2>${questionImage({ presenter: true })}${answerControl({ presenter: true })}${revealImage({ presenter: true })}</section>`;
  const displayedRound = ["door_choice", "door_reveal"].includes(state.phase) ? Number(state.targetRoundIndex) + 1 : state.question?.round || 1;
  const displayedTitle = ["door_choice", "door_reveal"].includes(state.phase) ? hostQuizDefinition?.rounds?.[state.targetRoundIndex]?.title || "Next round" : state.question?.roundTitle || "Quiz Control";
  const heading = state.presentationScreen === "title" ? "" : `<section class="presentation-round presentation-round--${state.phase}"><p class="eyebrow">${phaseLabel} · Round ${displayedRound} of ${state.question?.totalRounds || 1}</p><h1>${escapeHtml(state.phase === "complete" ? "Quiz Complete" : displayedTitle)}</h1>${state.phase === "open" ? timerDisplay() : ""}</section>`;
  const fullscreenControl = '<div class="presentation-fullscreen-corner"><button class="presentation-fullscreen-toggle" data-toggle-fullscreen aria-label="Toggle fullscreen presentation" title="Toggle fullscreen">⛶</button></div>';
  app.innerHTML = shell(`${brandTopbar()}<main class="presentation-main ${state.presentationScreen === "title" ? "presentation-main--title" : ""}">${heading}${card}${scoreCelebration()}</main>${fullscreenControl}${soundGate}`, true);
}

function playerScoreCards(players = state.players, limit = 6) {
  const ranked = [...players].sort((a, b) => Number(b.points) - Number(a.points) || String(a.name).localeCompare(String(b.name))).slice(0, limit);
  if (!ranked.length) return "";
  return `<ol class="player-mini-leaderboard">${ranked.map((leader, index) => `<li class="${leader.id === playerId ? "is-current-player" : ""}"><span class="player-mini-place">${index + 1}</span>${playerLogoMarkup(leader, "player-logo--mini")}<strong>${escapeHtml(leader.name)}</strong><b>${Number(leader.points) || 0}<small>pts</small></b></li>`).join("")}</ol>`;
}

function renderPlayer() {
  if (params.has("room") && !playerName) {
    const logoChoices = PLAYER_LOGOS.map((logo) => `<label class="player-logo-choice"><input type="radio" name="player-logo" value="${logo.key}" aria-label="${logo.label}" ${playerLogoKey === logo.key ? "checked" : ""} /><span class="player-logo player-logo--${logo.key}" aria-hidden="true">${playerLogoArtwork(logo)}</span></label>`).join("");
    app.innerHTML = shell(`<main class="player-main player-main--join">${brandTopbar()}<section class="player-card player-card--join"><header class="player-round"><p class="eyebrow">Join room ${roomCode}</p><h1>Ready to play?</h1></header><section class="player-question"><p>Choose a square player logo and enter the name you want shown on the leaderboard.</p><fieldset class="player-logo-picker"><legend>Player logo</legend><div>${logoChoices}</div></fieldset><label class="field"><span>Display name</span><input data-player-name maxlength="32" autocomplete="nickname" placeholder="Your name" /></label><div class="submit-bar"><button class="btn btn-primary" data-join-room>Join quiz</button></div></section></section></main>`, true);
    return;
  }
  if (state.presentationScreen === "title") {
    app.innerHTML = shell(`<main class="player-main player-main--holding">${brandTopbar()}<section class="player-card player-card--holding player-holding-card"><header class="player-round"><p class="eyebrow">You’re in, ${escapeHtml(playerName)}</p><h1>${escapeHtml(state.quizTitle || "Quiz night")}</h1>${playerIdentityBadge()}</header><section class="player-question"><p class="eyebrow">Title screen</p><h2>Get ready to play.</h2><p>${escapeHtml(state.quizSubtitle || "The host will start the first question shortly.")}</p><div class="player-waiting-pulse" aria-hidden="true"><i></i><i></i><i></i></div></section></section></main>`, true);
    return;
  }
  if (["door_choice", "door_reveal"].includes(state.phase)) {
    const result = activePlayerDoorResult();
    const selectedPick = (state.doorPicks || []).find((entry) => entry.playerId === playerId);
    const selectedDoor = doorBonusDefinition()?.doors?.find((door) => door.id === (result?.doorId || selectedPick?.doorId));
    const revealCopy = result ? `<div class="personal-door-result ${Number(result.multiplier) < 1 ? "is-penalty" : "is-boost"}"><span>${doorIconSymbol(selectedDoor?.icon)}</span><div><small>${escapeHtml(selectedDoor?.name || "Your door")}</small><strong>${formatMultiplier(result.multiplier)}</strong><p>This multiplier applies to every automatic point you earn in the next round.</p></div></div>` : `<div class="personal-door-result is-neutral"><span>—</span><div><small>No door selected</small><strong>1×</strong><p>You’ll play the next round at the standard multiplier.</p></div></div>`;
    app.innerHTML = shell(`<main class="player-main player-main--doors">${brandTopbar()}<section class="player-card player-card--doors"><header class="player-round"><p class="eyebrow">Between rounds</p><h1>${state.phase === "door_reveal" ? "Your reward is in" : "Choose your door"}</h1>${playerIdentityBadge()}</header><section class="player-door-content">${state.phase === "door_reveal" ? revealCopy : `<p>Pick one. You can change your mind until the host reveals the rewards.</p>${doorChoiceCards({ interactive: true })}<span class="door-phone-status" role="status">${selectedDoor ? `You picked ${escapeHtml(selectedDoor.name)}.` : "Choose a door to lock in your chance."}</span>`}</section></section></main>`, true);
    return;
  }
  if (state.phase === "lobby" || state.presentationScreen === "intermission") {
    app.innerHTML = shell(`<main class="player-main player-main--intermission">${brandTopbar()}<section class="player-card player-card--intermission player-holding-card"><header class="player-round"><p class="eyebrow">Scoreboard</p><h1>Next question coming up</h1>${playerIdentityBadge()}${activeMultiplierBadge()}</header><section class="player-question"><p class="eyebrow">Between questions</p><h2>Stay on this screen.</h2><p>The host is showing the leaderboard. The next question will appear here when it starts.</p>${playerScoreCards()}<div class="player-waiting-pulse" aria-hidden="true"><i></i><i></i><i></i></div></section></section></main>`, true);
    return;
  }
  const submissionKey = `quiz-submitted:${roomCode}:${state.questionId || state.question?.id}`;
  const isSubmitted = sessionStorage.getItem(submissionKey) === "true";
  const manualSubmit = ["short_answer", "fill_in_the_blank", "numeric_estimate", "closest_number"].includes(state.question?.type);
  const phaseMessage = state.phase === "locked" ? "Answers are locked." : state.phase === "reveal" ? "Answer revealed." : state.phase === "complete" ? "Thanks for playing—the final leaderboard is on the shared screen." : isSubmitted ? (manualSubmit ? "Answer submitted. You can still change it until reveal." : "Selection saved. You can change it until reveal.") : manualSubmit ? "Type your answer, then submit." : "Make your selection. It saves automatically.";
  const playerType = escapeHtml(state.question?.type || "question");
  app.innerHTML = shell(`<main class="player-main player-main--question"><div class="player-question-frame">${brandTopbar()}<section class="player-card player-card--question player-card--${escapeHtml(state.phase || "open")} player-card--${playerType}"><header class="player-round"><p class="eyebrow">${state.phase === "complete" ? "Final standings" : `Round ${state.question.round || 1} of ${state.question.totalRounds || 1}`}</p><h1>${state.phase === "complete" ? "Quiz Complete" : state.question.roundTitle}</h1>${playerIdentityBadge()}${activeMultiplierBadge()}${timerDisplay()}</header><section class="player-question player-question--${playerType}"><div class="player-prompt-card"><p class="eyebrow">${state.phase === "open" ? "Question" : state.phase === "reveal" ? "Answer reveal" : state.phase === "complete" ? "Finished" : "Locked"}</p><h2>${state.phase === "complete" ? "Thanks for playing." : state.question.prompt}</h2>${state.phase === "complete" ? playerScoreCards(state.players, 8) : questionImage({player:true})}</div><div class="player-response-panel">${state.phase === "complete" ? "" : answerControl({player:true})}${revealImage({player:true})}<div class="submit-bar"><span data-submission-status class="${isSubmitted ? "submitted" : state.phase === "locked" ? "submitted locked" : ""}">${phaseMessage}</span>${state.phase === "open" && manualSubmit ? '<button class="btn btn-primary" data-submit ' + (!answerReady() ? 'disabled' : '') + '>Submit</button>' : ''}</div></div></section></section></div></main>`, true);
}

function render() {
  imageMediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  imageMediaObjectUrls = [];
  if (view === "host") renderHost();
  else if (view === "presenter") renderPresenter();
  else if (view === "player") renderPlayer();
  else renderLanding();
  attachEvents();
}

function endDrag(event) {
  if (!activeDrag) return;
  const { ghost, card, kind, itemId } = activeDrag;
  ghost.remove();
  card.classList.remove("is-dragging");
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-drop-zone]");
  const board = target?.closest("[data-drag-board]");
  activeDrag = null;
  if (!target || board?.dataset.dragBoard !== kind) return;
  const assignments = { ...selectedObject() };
  if (kind === "order") {
    const ids = [...document.querySelectorAll("[data-drop-zone=order] [data-drag-item]")].map((entry) => entry.dataset.dragItem);
    const from = ids.indexOf(itemId);
    const targetCard = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-drag-item]");
    const to = targetCard ? ids.indexOf(targetCard.dataset.dragItem) : ids.length - 1;
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, itemId);
    selected = Object.fromEntries(ids.map((id, index) => [id, String(index + 1)]));
  } else if (kind === "matching") {
    delete assignments[itemId];
    if (target.dataset.dropZone === "matching-slot") assignments[itemId] = target.dataset.optionId;
    selected = assignments;
  } else if (kind === "categorize") {
    if (target.dataset.dropZone === "categorize-bucket") assignments[itemId] = target.dataset.categoryId;
    else delete assignments[itemId];
    selected = assignments;
  }
  render();
  queueAutoSubmission();
}

function startDrag(event) {
  const card = event.currentTarget;
  if (view !== "player" || state.phase !== "open" || event.button > 0) return;
  event.preventDefault();
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${event.clientX - rect.width / 2}px`;
  ghost.style.top = `${event.clientY - rect.height / 2}px`;
  document.body.append(ghost);
  card.classList.add("is-dragging");
  activeDrag = { card, ghost, kind: card.dataset.dragKind, itemId: card.dataset.dragItem };
  const move = (moveEvent) => { if (activeDrag) { ghost.style.left = `${moveEvent.clientX - rect.width / 2}px`; ghost.style.top = `${moveEvent.clientY - rect.height / 2}px`; } };
  const finish = (finishEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); endDrag(finishEvent); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish, { once: true });
  window.addEventListener("pointercancel", finish, { once: true });
}

function setSubmissionStatus(message, className = "") {
  const status = document.querySelector("[data-submission-status]");
  if (!status) return;
  status.textContent = message;
  status.className = className;
}

function queueAutoSubmission() {
  if (view !== "player" || state.phase !== "open" || !answerReady()) return;
  clearTimeout(autoSubmitTimer);
  setSubmissionStatus("Saving selection…");
  autoSubmitTimer = setTimeout(() => {
    const answer = structuredClone(selected);
    const questionId = state.questionId || state.question?.id || "sample-question";
    const serverRevision = state.revision || 0;
    submissionSequence = submissionSequence.catch(() => {}).then(async () => {
      // The host may lock or advance the question during the short debounce
      // window or while another answer is being saved. Do not turn that
      // expected race into a rejected RPC (and a Sentry error).
      if (view !== "player" || state.phase !== "open" || (state.questionId || state.question?.id || "sample-question") !== questionId || (state.revision || 0) !== serverRevision) return;
      try {
        if (params.has("room")) await roomApi.submitAnswer({ roomCode, playerToken: playerId, questionId, answer, serverRevision });
        state.submitted[playerId] = answer;
        sessionStorage.setItem(`quiz-submitted:${roomCode}:${questionId}`, "true");
        sendSubmission(answer);
        setSubmissionStatus("Selection saved. You can change it until reveal.", "submitted");
      } catch (error) {
        recordDiagnostic("auto-submit-answer", error, { roomCode, questionId });
        setSubmissionStatus("Selection was not saved. Tap it again to retry.", "submitted locked");
      }
    });
  }, 40);
}

function updateMatchingSelectAvailability() {
  const assignments = selectedObject();
  const used = new Set(Object.values(assignments).filter(Boolean));
  document.querySelectorAll("[data-match-select]").forEach((select) => {
    const ownValue = assignments[select.dataset.matchSelect];
    [...select.options].forEach((option) => {
      if (option.value) option.disabled = used.has(option.value) && option.value !== ownValue;
    });
  });
}

function attachEvents() {
  document.querySelector("[data-create-room]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Creating room…";
    try {
      const hostSecret = randomRoomSecret();
      const quizVersionId = document.querySelector("[data-quiz-version]")?.value || roomApi.defaultQuizVersionId;
      const created = await roomApi.createRoom({ quizVersionId, hostSecret, initialState: publicRoomState() });
      saveHostSecret(created.roomCode, hostSecret);
      location.href = `?view=host&room=${encodeURIComponent(created.roomCode)}`;
    } catch (error) {
      button.disabled = false;
      button.textContent = "Create hosted room";
      alert(`Could not create the room: ${error.message}`);
    }
  });
  document.querySelector("[data-join-by-code]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = document.querySelector("#room-code").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { document.querySelector("#room-code").focus(); return; }
    location.href = `?view=player&room=${encodeURIComponent(code)}`;
  });
  document.querySelector("[data-copy-link]")?.addEventListener("click", async () => {
    const input = document.querySelector('input[aria-label="Player join link"]');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand("copy"); }
  });
  document.querySelectorAll("[data-preflight-item]").forEach((input) => input.addEventListener("change", () => {
    const key = `quiz-preflight:${roomCode}`;
    let completed = {};
    try { completed = JSON.parse(sessionStorage.getItem(key) || "{}"); } catch { /* Replace malformed data. */ }
    completed[input.dataset.preflightItem] = input.checked;
    sessionStorage.setItem(key, JSON.stringify(completed));
  }));
  document.querySelectorAll("[data-start-timer]").forEach((button) => button.addEventListener("click", () => startTimer(Number(button.dataset.startTimer))));
  document.querySelector("[data-clear-timer]")?.addEventListener("click", clearTimer);
  document.querySelector("[data-join-room]")?.addEventListener("click", async () => {
    const input = document.querySelector("[data-player-name]");
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    playerLogoKey = normalizePlayerLogoKey(document.querySelector('input[name="player-logo"]:checked')?.value);
    try {
      const joined = await roomApi.joinRoom({ roomCode, displayName: name, playerToken: playerId, logoKey: playerLogoKey });
      playerName = name;
      sessionStorage.setItem("musicTriviaPlayerName", name);
      sessionStorage.setItem("quizPlayerLogoKey", playerLogoKey);
      state = { ...state, ...joined.state, revision: joined.revision };
      announcePlayerPresence();
      render();
    } catch (error) { alert(`Could not join this room: ${error.message}`); }
  });
  document.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
    const optionId = button.dataset.answer;
    if (state.question.type === "multiple_choice") {
      const selectedSet = new Set(Array.isArray(selected) ? selected : []);
      selectedSet.has(optionId) ? selectedSet.delete(optionId) : selectedSet.add(optionId);
      selected = [...selectedSet];
    } else selected = optionId;
    if (view === "player") {
      document.querySelectorAll("[data-answer]").forEach((answerButton) => {
        const isSelected = state.question.type === "multiple_choice" ? selected.includes(answerButton.dataset.answer) : selected === answerButton.dataset.answer;
        answerButton.classList.toggle("is-selected", isSelected);
      });
      queueAutoSubmission();
    }
  }));
  document.querySelectorAll("[data-categorize-item]").forEach((button) => button.addEventListener("click", () => {
    selected = { ...selectedObject(), [button.dataset.categorizeItem]: button.dataset.categoryId };
    button.closest(".categorize-tap-row")?.querySelectorAll("button").forEach((choice) => choice.classList.toggle("is-selected", choice === button));
    queueAutoSubmission();
  }));
  document.querySelectorAll("[data-match-select]").forEach((select) => select.addEventListener("change", () => {
    const assignments = { ...selectedObject() };
    if (select.value) assignments[select.dataset.matchSelect] = select.value;
    else delete assignments[select.dataset.matchSelect];
    selected = assignments;
    updateMatchingSelectAvailability();
    queueAutoSubmission();
  }));
  document.querySelector("[data-text-answer]")?.addEventListener("input", (event) => { selected = event.target.value; const submit = document.querySelector("[data-submit]"); if (submit) submit.disabled = !answerReady(); });
  document.querySelectorAll("[data-drag-item]").forEach((card) => card.addEventListener("pointerdown", startDrag));
  document.querySelectorAll("[data-phase]").forEach((button) => button.addEventListener("click", () => button.dataset.phase === "locked" ? lockQuestion() : setPhase(button.dataset.phase)));
  document.querySelector("[data-reveal-question]")?.addEventListener("click", revealQuestion);
  document.querySelector("[data-reveal-doors]")?.addEventListener("click", revealDoorRewards);
  document.querySelector("[data-next]")?.addEventListener("click", advanceQuestion);
  document.querySelectorAll("[data-choose-door]").forEach((button) => button.addEventListener("click", async () => {
    if (view !== "player" || state.phase !== "door_choice") return;
    const doorId = button.dataset.chooseDoor;
    button.disabled = true;
    try {
      const payload = params.has("room") ? await roomApi.chooseDoor({ roomCode, playerToken: playerId, doorId }) : { playerId, playerName, logoKey: playerLogoKey, doorId };
      payload.playerName ||= playerName; payload.logoKey ||= playerLogoKey;
      state.doorPicks = [...(state.doorPicks || []).filter((entry) => entry.playerId !== playerId), payload];
      localChannel.postMessage({ type: "door-choice", payload });
      realtimeChannel?.send({ type: "broadcast", event: "door-choice", payload });
      render();
    } catch (error) {
      recordDiagnostic("door-choice", error, { roomCode, doorId });
      alert(`Your door was not saved. Please try again.\n\n${error.message}`);
      button.disabled = false;
    }
  }));
  document.querySelector("[data-jump-question-button]")?.addEventListener("click", jumpToQuestion);
  document.querySelector("[data-reset]")?.addEventListener("click", reset);
  document.querySelector("[data-export-results]")?.addEventListener("click", exportResults);
  document.querySelector("[data-export-detailed-results]")?.addEventListener("click", exportDetailedResults);
  document.querySelector("[data-download-diagnostics]")?.addEventListener("click", downloadDiagnostics);
  document.querySelectorAll("[data-toggle-shortcuts]").forEach((button) => button.addEventListener("click", () => {
    const guide = document.querySelector("[data-shortcut-guide]");
    if (guide) guide.hidden = !guide.hidden;
  }));
  document.querySelector("[data-toggle-fullscreen]")?.addEventListener("click", async () => {
    try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch { alert("Presentation mode is not available in this browser."); }
  });
  document.querySelector("[data-adjust-score]")?.addEventListener("click", async (event) => {
    const playerId = document.querySelector("[data-score-player]")?.value;
    const points = Number(document.querySelector("[data-score-points]")?.value);
    const reason = document.querySelector("[data-score-reason]")?.value?.trim() || "Host manual adjustment";
    if (!playerId || !Number.isFinite(points) || points === 0) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const hostSecret = getHostSecret();
      await roomApi.adjustScore({ roomCode, hostSecret, playerId, points, reason });
      state.players = await roomApi.getLeaderboard({ roomCode, accessToken: hostSecret });
      const player = state.players.find((entry) => entry.id === playerId);
      state.scoreNotification = { playerName: player?.name || "Player", points, reason, expiresAt: new Date(Date.now() + 6500).toISOString() };
      clearTimeout(scoreNotificationTimer);
      scoreNotificationTimer = setTimeout(async () => {
        if (!state.scoreNotification) return;
        state.scoreNotification = null;
        await persistHostState();
        emit();
        render();
      }, 6600);
      await persistHostState();
      emit();
      render();
    } catch (error) {
      alert(`Could not adjust score: ${error.message}`);
      button.disabled = false;
    }
  });
  document.querySelector("[data-submit]")?.addEventListener("click", async (event) => {
    if (selected === null) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Submitting…";
    try {
      if (params.has("room")) await roomApi.submitAnswer({ roomCode, playerToken: playerId, questionId: state.questionId || state.question.id || "sample-question", answer: selected, serverRevision: state.revision || 0 });
      state.submitted[playerId] = selected;
      sessionStorage.setItem(`quiz-submitted:${roomCode}:${state.questionId || state.question?.id}`, "true");
      sendSubmission(selected);
      render();
    } catch (error) {
      recordDiagnostic("submit-answer", error, { roomCode });
      console.warn("Could not persist answer.", error);
      alert(`Your answer was not submitted. Please try again.\n\n${error.message}`);
      button.disabled = false;
      button.textContent = "Submit";
    }
  });
  document.querySelector("[data-player]")?.addEventListener("click", () => {
    const name = `Player ${state.players.length + 1}`;
    state.players.push({ id: crypto.randomUUID(), name, logoKey: PLAYER_LOGOS[state.players.length % PLAYER_LOGOS.length].key, points: 0 }); emit(); render();
  });
  document.querySelectorAll("[data-audio-command]").forEach((button) => button.addEventListener("click", async () => {
    if (view !== "host" || !hostQuizDefinition) return;
    state.audioCommand = { id: crypto.randomUUID(), action: button.dataset.audioCommand, audioScope: button.dataset.audioScope, questionId: button.dataset.audioScope === "question" ? hostQuestion.id : null };
    await persistHostState();
    emit();
  }));
  document.querySelectorAll("[data-play-intro]").forEach((button) => button.addEventListener("click", async () => {
    if (view !== "host" || !hostQuizDefinition) return;
    state.activeClipId = button.dataset.playIntro;
    state.audioCommand = { id: crypto.randomUUID(), action: "play", audioScope: "question", questionId: hostQuestion.id, clipId: state.activeClipId };
    await persistHostState();
    emit();
    render();
  }));
  document.querySelector("[data-arm-presentation-audio]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const status = document.querySelector("[data-arm-audio-status]");
    button.disabled = true;
    button.textContent = "Enabling…";
    if (status) status.textContent = "";
    try {
      await armPresentationAudio();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Try again";
      if (status) status.textContent = error.message || "Sound could not be enabled.";
    }
  });
  if (view === "presenter" && presentationAudioArmed) {
    preparePresentationAudio().then(applyPresentationAudioCommand).catch((error) => console.warn("Presentation clip unavailable.", error));
  }
  refreshAnonymousTextAnswers();
  document.querySelectorAll("[data-private-image]").forEach((image) => {
    loadPrivateImage(image).catch(() => image.remove());
  });
  document.querySelectorAll("[data-join-qr]").forEach((qrCanvas) => import("https://esm.sh/qrcode@1.5.4").then(({ toCanvas }) => toCanvas(qrCanvas, `${location.origin}${location.pathname}?view=player&room=${encodeURIComponent(roomCode)}`, { width: 150, margin: 1, color: { dark: "#240f6e", light: "#ffffff" } })).catch(() => qrCanvas.remove()));
  startTimerTicker();
}

window.addEventListener("keydown", (event) => {
  if (view === "presenter" && event.key.toLowerCase() === "f" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    document.querySelector("[data-toggle-fullscreen]")?.click();
    return;
  }
  if (view !== "host") return;
  if (event.key === "?" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) document.querySelector("[data-toggle-shortcuts]")?.click();
  if (event.code === "Space" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    const audioButton = document.querySelector('[data-audio-command="play"]');
    if (audioButton) { event.preventDefault(); audioButton.click(); return; }
  }
  if (event.key.toLowerCase() === "n" && state.phase === "lobby") setPhase("open");
  if (event.key.toLowerCase() === "n" && state.phase === "reveal") advanceQuestion();
  if (event.key.toLowerCase() === "n" && state.phase === "door_reveal") advanceQuestion();
  if (event.key.toLowerCase() === "r" && state.phase === "door_choice") revealDoorRewards();
  if (event.key.toLowerCase() === "r" && ["open", "locked"].includes(state.phase)) revealQuestion();
});

startDiagnostics(view);
render();
connectHostedRoom();

if (view === "landing" && roomApi.configured) {
  roomApi.listQuizCatalog().then((catalog) => {
    availableQuizzes = catalog;
    render();
  }).catch((error) => console.warn("Could not load quiz catalog.", error));
}
