// Shared client-safe quiz helpers. These functions deliberately expose only
// data a joined player needs; scoring remains authoritative in Supabase.

export function toPlayerQuestion(question = {}) {
  const playerQuestion = { id: question.id, type: question.type, prompt: question.prompt };
  if (question.options !== undefined) playerQuestion.options = question.options.map(({ id, label, imageAssetId }) => ({ id, label, ...(imageAssetId ? { imageAssetId } : {}) }));
  for (const key of ["items", "categories"]) if (question[key] !== undefined) playerQuestion[key] = question[key];
  if (question.clips !== undefined) playerQuestion.clips = question.clips.map(({ id, label }) => ({ id, label }));
  if (question.pointsPerBlank !== undefined) playerQuestion.pointsPerBlank = question.pointsPerBlank;
  return playerQuestion;
}

export function correctOptionId(question = {}) {
  return question.correctOptionIds?.[0] || question.options?.[question.correctOption]?.id || null;
}

// A player's saved name/logo (see app.js's persistedPlayerValue) should let a
// phone rejoin after an accidental tab close, but only within one live
// session -- not forever. app.js stamps a last-active timestamp alongside the
// identity and clears it once this says the gap is too long, so the next
// game on a different day asks the player to join fresh instead of quietly
// reusing last time's name and logo.
export const PLAYER_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function isPlayerSessionExpired(lastActiveAt, now = Date.now(), ttlMs = PLAYER_SESSION_TTL_MS) {
  const lastActive = Number(lastActiveAt);
  if (!Number.isFinite(lastActive)) return true;
  return now - lastActive > ttlMs;
}

// The TTL above bounds *how long ago* a phone last played. It cannot express
// *which room* it played in, and those are orthogonal questions: a phone that
// played room ABC123 an hour ago and then scans the QR for the unrelated room
// XYZ789 is well inside the TTL, yet must still be asked for a fresh name and
// logo. So the identity is stored as a small map keyed by room code, and each
// room's entry carries its own lastActiveAt and expires on its own TTL.
//
// Room codes are safe to key on. public.room_code() draws 6 characters from a
// 32-character alphabet, sessions.room_code is `unique`, and create_live_room
// retries on unique_violation (supabase/migrations/0002_live_room_rpc.sql), so
// two sessions can never share a code. No migration deletes session rows, so a
// code is never recycled onto a later, unrelated game either. The code is
// therefore a durable room identifier, not a reusable slot.
//
// Entries for other rooms are RETAINED rather than clobbered on a new join:
// a player who opens the wrong QR code, picks a name, then rescans the right
// one has to land back on their real score, and a host running two rooms back
// to back has to be able to send a phone back to the first. The map is pruned
// of expired entries and capped on every write, so it cannot grow unbounded.
export const PLAYER_IDENTITY_ROOM_LIMIT = 8;

function parsePlayerIdentityStore(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A hand-edited or half-written localStorage value must not break the
    // join screen; an unreadable store simply means "no saved identity".
    return {};
  }
}

// Every room entry still inside its own TTL, most recently active first.
export function readPlayerIdentityStore(raw, now = Date.now(), ttlMs = PLAYER_SESSION_TTL_MS) {
  const entries = [];
  for (const [room, entry] of Object.entries(parsePlayerIdentityStore(raw))) {
    if (!room || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (isPlayerSessionExpired(entry.lastActiveAt, now, ttlMs)) continue;
    entries.push([room, {
      playerId: String(entry.playerId || ""),
      playerName: String(entry.playerName || ""),
      logoKey: String(entry.logoKey || ""),
      lastActiveAt: Number(entry.lastActiveAt)
    }]);
  }
  entries.sort((left, right) => right[1].lastActiveAt - left[1].lastActiveAt);
  return Object.fromEntries(entries);
}

// The identity this device may resume in `roomCode`, or null when the join
// screen should ask fresh. A different room, or this room past its TTL, both
// return null -- that is the entire point of keying the map.
export function playerIdentityForRoom(raw, roomCode, now = Date.now(), ttlMs = PLAYER_SESSION_TTL_MS) {
  if (!roomCode) return null;
  const entry = readPlayerIdentityStore(raw, now, ttlMs)[roomCode];
  return entry && entry.playerId ? entry : null;
}

// Serialize `identity` under `roomCode`, refreshing that room's activity
// stamp and leaving every other room's entry (and its own clock) untouched.
// Pass identity.lastActiveAt to adopt an existing stamp instead of restamping
// to now -- the legacy migration in app.js needs the original timestamp so a
// stale identity does not get its TTL silently extended.
export function writePlayerIdentityForRoom(raw, roomCode, identity = {}, now = Date.now(), ttlMs = PLAYER_SESSION_TTL_MS) {
  if (!roomCode) return raw || "";
  const stamped = Number(identity.lastActiveAt);
  const lastActiveAt = Number.isFinite(stamped) ? stamped : now;
  const store = readPlayerIdentityStore(raw, now, ttlMs);
  delete store[roomCode];
  const others = Object.entries(store).slice(0, PLAYER_IDENTITY_ROOM_LIMIT - 1);
  const current = {
    playerId: String(identity.playerId || ""),
    playerName: String(identity.playerName || ""),
    logoKey: String(identity.logoKey || ""),
    lastActiveAt
  };
  return JSON.stringify(Object.fromEntries([[roomCode, current], ...others]));
}

// Clamp a host-set presentation volume to a valid gain (0..1), falling back
// to full volume for anything unset or non-numeric.
export function normalizedAudioVolume(value) {
  const volume = Number(value);
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
}

// The opening and closing presentation title cards carry a "presented by"
// credit line above the quiz title. The quiz file supplies the authored
// default (titlePage.presenter), but one quiz often runs for several different
// audiences, so the host screen can override that credit for a single session.
// The override travels in room state and is never written back into the quiz
// JSON — that is the whole point, so the same file stays reusable.
//
// An override counts only when it has visible text. Blanking the host field
// therefore restores the authored credit instead of hiding the line, while an
// authored empty string still hides it (`??`, not `||`), which is how a quiz
// deliberately opts out of the credit line.
export const DEFAULT_PRESENTER_CREDIT = "ADO&S PRESENTS";

export function resolvePresenterCredit(override, authoredPresenter) {
  const trimmedOverride = typeof override === "string" ? override.trim() : "";
  if (trimmedOverride) return trimmedOverride;
  return authoredPresenter ?? DEFAULT_PRESENTER_CREDIT;
}

// Host-only, post-reveal analytics: how many submitted answers were correct,
// broken down per part for multi-part question types. This never decides
// scoring — it only summarizes raw answers the host already collected
// (state.submitted) against the question's own correct-answer key, which
// the host already holds and which is the same data already revealed to
// players via publicRoomState()'s revealedXxx fields. It intentionally
// mirrors the comparison rules in
// supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql so the
// host's "who got it right" summary agrees with what was actually scored;
// if that migration's comparison logic changes, this must change with it.
function normalizeAnswerText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isValidNumericAnswer(value) {
  return /^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$/.test(String(value ?? "").trim());
}

// Returns null for single-part question types. For multi-part types
// (matching, categorize, multi_fill_in_the_blank) returns one
// { partId, label, isCorrect(answer) } predicate per named part.
function partPredicates(question = {}) {
  if (question.type === "matching") {
    return Object.entries(question.correctPairs || {}).map(([sourceId, targetId]) => ({
      partId: sourceId,
      label: question.clips?.find((clip) => clip.id === sourceId)?.label || sourceId,
      isCorrect: (answer) => answer?.[sourceId] === targetId
    }));
  }
  if (question.type === "categorize") {
    return Object.entries(question.correctCategories || {}).map(([itemId, categoryId]) => ({
      partId: itemId,
      label: question.items?.find((item) => item.id === itemId)?.label || itemId,
      isCorrect: (answer) => answer?.[itemId] === categoryId
    }));
  }
  if (question.type === "multi_fill_in_the_blank") {
    return (question.clips || []).map((clip, index) => {
      const accepted = (clip.acceptedAnswers || []).map(normalizeAnswerText);
      return {
        partId: clip.id,
        label: clip.label || `Blank ${index + 1}`,
        isCorrect: (answer) => accepted.includes(normalizeAnswerText(answer?.[clip.id]))
      };
    });
  }
  return null;
}

function isSingleAnswerCorrect(question = {}, answer, closestNumberWinningDistance) {
  switch (question.type) {
    case "single_choice":
    case "true_false":
    case "image_selection": {
      const correctIds = question.correctOptionIds || (correctOptionId(question) ? [correctOptionId(question)] : []);
      return correctIds.includes(answer);
    }
    case "multiple_choice": {
      const expected = [...(question.correctOptionIds || [])].sort();
      const actual = Array.isArray(answer) ? [...answer].sort() : [];
      return expected.length > 0 && expected.length === actual.length && expected.every((id, index) => id === actual[index]);
    }
    case "short_answer":
    case "fill_in_the_blank": {
      const accepted = question.acceptedAnswers || question.blanks?.[0]?.acceptedAnswers || [];
      return accepted.some((candidate) => normalizeAnswerText(candidate) === normalizeAnswerText(answer));
    }
    case "arrange_in_order": {
      const order = question.correctOrder || [];
      return order.length > 0 && order.every((itemId, index) => String(answer?.[itemId]) === String(index + 1));
    }
    case "closest_number":
      return isValidNumericAnswer(answer) && closestNumberWinningDistance !== null && Math.abs(Number(answer) - Number(question.targetNumber)) === closestNumberWinningDistance;
    default:
      return false;
  }
}

export function tallyQuestionResults(question = {}, submissions = {}) {
  const answers = Object.values(submissions || {});
  const totalSubmitted = answers.length;
  const parts = partPredicates(question);

  if (parts) {
    return {
      totalSubmitted,
      correctCount: answers.filter((answer) => parts.every((part) => part.isCorrect(answer))).length,
      parts: parts.map((part) => ({ partId: part.partId, label: part.label, correctCount: answers.filter((answer) => part.isCorrect(answer)).length }))
    };
  }

  let closestNumberWinningDistance = null;
  if (question.type === "closest_number") {
    const target = Number(question.targetNumber);
    const distances = answers.filter(isValidNumericAnswer).map((answer) => Math.abs(Number(answer) - target));
    closestNumberWinningDistance = distances.length ? Math.min(...distances) : null;
  }

  return { totalSubmitted, correctCount: answers.filter((answer) => isSingleAnswerCorrect(question, answer, closestNumberWinningDistance)).length, parts: null };
}

// The Host screen is an operator console, not a projection of room state. It
// carries keyboard focus, half-typed manual-score and question-jump entries, a
// running timer interval, and privately proxied media whose object URLs are
// revoked and refetched on every render. Rebuilding it through app.innerHTML
// whenever a phone taps an answer destroys all of that, which is what the host
// experiences as the screen "refreshing a lot".
//
// So the Host gets the same remount boundary the player and presentation views
// already have. Everything stripped below is either transport-only or a live
// counter that app.js's patchHostLiveRegions() updates in place; classifying
// each broadcast field as structural, visual, or transport-only before putting
// it in a remount boundary is lesson 14 in mistakes.md.
//
// This is a denylist, not an allowlist, so a newly added state field defaults
// to remounting the Host. A stale host screen is worse than a flickery one
// during a live show; add a field here only once something patches it.
export const HOST_LIVE_STATE_FIELDS = [
  "submitted",         // one entry per answered player -- the answers-received counter and the reveal results panel
  "players",           // roster and points -- the leaderboard, the counter's denominator, the manual-score picker
  "doorPicks",         // between-round door choices -- the host doors board
  "revision",          // server state version; nothing on the Host renders it
  "audioCommand",      // cross-tab audio cue transport
  "mediaCommand",      // cross-tab video cue transport
  "activeClipId",      // which intro is cued -- highlighted on the matching-clip buttons
  "audioVolume",       // the volume slider owns its own value while dragging
  "scoreNotification", // shell() renders this for players only
  "mediaPlayback"      // recorded for diagnostics; nothing on the Host reads it
];

export function hostRenderKey(roomState) {
  const structural = { ...(roomState || {}) };
  for (const field of HOST_LIVE_STATE_FIELDS) delete structural[field];
  // Sort the top level so a locally built state and an inbound JSON payload
  // that hold the same values cannot disagree purely on key order.
  const ordered = {};
  for (const key of Object.keys(structural).sort()) ordered[key] = structural[key];
  return JSON.stringify(ordered);
}

// The two numbers the host watches constantly ("3 / 12 answers received").
// Shared so the full render and the in-place patch cannot drift apart.
export function hostLiveCounts(roomState) {
  return {
    submitted: Object.keys(roomState?.submitted || {}).length,
    players: Array.isArray(roomState?.players) ? roomState.players.length : 0
  };
}
// --- Reveal keys -------------------------------------------------------------
//
// Two halves of one contract, kept together on purpose. publicRoomState() in
// app.js publishes the authoritative answer key for the current question once
// the host reveals it; the answer boards read it back. When those halves are
// written independently a question type can ship with the key published but no
// surface reading it -- or, as arrange_in_order did, with no published field at
// all, while the boards quietly invented a "correct" answer out of whatever
// question data was in reach (review 2026-08-17, C6 / APP F1: Presentation
// announced the authored item order and the player's phone announced the
// player's own submission, both labelled "Correct order", while Supabase had
// already scored against the real key).
//
// This does not move scoring into the browser. These are the same values the
// scoring RPC used, projected to clients only after the host reveals.

// Every authored question type, mapped to the field of the public room state
// that carries its answer key. A type missing from this table has no key to
// reveal, and revealKeyFor() returns null for it rather than guessing.
export const REVEAL_KEY_FIELDS = {
  single_choice: "revealedCorrectOptionIds",
  multiple_choice: "revealedCorrectOptionIds",
  true_false: "revealedCorrectOptionIds",
  image_selection: "revealedCorrectOptionIds",
  short_answer: "revealedTextAnswers",
  fill_in_the_blank: "revealedTextAnswers",
  multi_fill_in_the_blank: "revealedMultiBlankAnswers",
  arrange_in_order: "revealedCorrectOrder",
  categorize: "revealedCorrectCategories",
  matching: "revealedCorrectPairs",
  closest_number: "revealedNumber"
};

// The revealed* block of publicRoomState(). Every field is always present, so
// a client can tell "nothing revealed yet" from "revealed and empty" without
// checking the phase, and every field is empty in every phase but `reveal`.
export function revealedAnswerKeys(question = {}, phase) {
  const revealed = phase === "reveal";
  const firstCorrectOptionId = revealed ? correctOptionId(question) : null;
  return {
    revealedCorrectOptionId: firstCorrectOptionId,
    revealedCorrectOptionIds: revealed ? question.correctOptionIds || (firstCorrectOptionId ? [firstCorrectOptionId] : []) : [],
    revealedCorrectCategories: revealed && question.type === "categorize" ? question.correctCategories || {} : {},
    revealedCorrectPairs: revealed && question.type === "matching" ? question.correctPairs || {} : {},
    revealedMultiBlankAnswers: revealed && question.type === "multi_fill_in_the_blank" ? Object.fromEntries((question.clips || []).map((clip) => [clip.id, clip.acceptedAnswers || []])) : {},
    revealedCorrectOrder: revealed && question.type === "arrange_in_order" ? question.correctOrder || [] : [],
    revealedTextAnswers: revealed && ["short_answer", "fill_in_the_blank"].includes(question.type) ? question.acceptedAnswers || question.blanks?.[0]?.acceptedAnswers || [] : [],
    revealedNumber: revealed && question.type === "closest_number" ? Number(question.targetNumber) : null
  };
}

const EMPTY_REVEAL_KEYS = revealedAnswerKeys({}, null);

// The answer key a surface is allowed to render right now.
//
// `surface` is "host" for the host's own laptop, which holds the quiz
// definition and may read the key in any phase, or "client" for a player phone
// or Presentation, which are projections: they get exactly what the room state
// published and never recompute a key from the question object they were
// handed. `revealed` is that published room state.
export function revealKeyFor(question = {}, phase, surface, revealed = {}) {
  const field = REVEAL_KEY_FIELDS[question.type];
  if (!field) return null;
  if (surface === "host") return revealedAnswerKeys(question, "reveal")[field];
  return revealed?.[field] ?? EMPTY_REVEAL_KEYS[field];
}

// --- Presentation remount boundary -------------------------------------------
//
// Presentation re-renders only when this key changes, because a re-render is
// expensive there: it revokes every private-image object URL and re-issues a
// Worker fetch for each one, and every entrance animation restarts. A field
// that is not part of what the shared screen currently shows must therefore
// stay out of the key and, where it is visible at all, be applied in place.
//
// mistakes.md #14 asks that every broadcast field be classified structural,
// visual, or transport-only before it enters this boundary. Six were; four
// were not, and each of those four remounted the shared screen mid-question
// (review 2026-08-17, C15 / APP F3).

// Scenes that put the roster or a scoreboard on the shared screen, and so must
// redraw when `players` changes. Everywhere else -- a question, the locked
// board, a reveal -- `players` is transport-only, and a late join or a score
// adjustment must not blank and re-download the question image.
const PRESENTATION_ROSTER_SCREENS = new Set([
  "title", // the waiting-room roster
  "round_end", // roundTransitionCard's end-of-round scoreboard
  "final_podium", // the top three
  "final_scores" // the paged final standings
]);

// The door cards read doorPicks (and doorResults, which is structural and
// always in the key) only while the doors are the scene.
const PRESENTATION_DOOR_PHASES = new Set(["door_choice", "door_reveal"]);

export function presenterRenderKey(roomState) {
  const {
    // Transport-only. Audio and video cues bump the revision and replace the
    // command, but a cue is applied to the mounted DOM, never by remounting it.
    activeClipId,
    audioCommand,
    revision,
    submitted,
    audioVolume,
    mediaCommand,
    // Host navigation history. Presentation never renders it at all.
    screenHistory,
    // A fixed overlay appended after the card, not part of the scene. It is
    // swapped in place, so neither its arrival nor its expiry may remount --
    // which used to mean a manual score adjustment remounted the reveal twice.
    scoreNotification,
    // Visual on some scenes only; re-added below when they are the scene.
    players,
    doorPicks,
    ...visualState
  } = roomState || {};
  // `complete` renders the final leaderboard without going through one of the
  // finale screens, so it needs the roster too.
  if (PRESENTATION_ROSTER_SCREENS.has(visualState.presentationScreen) || visualState.phase === "complete") visualState.players = players;
  if (PRESENTATION_DOOR_PHASES.has(visualState.phase)) visualState.doorPicks = doorPicks;
  return JSON.stringify(visualState);
}

// --- Standings ---------------------------------------------------------------
//
// One ranking rule for every surface that shows a position. Six sites ranked
// players independently and only three shared rank between tied players, so the
// exported standings CSV could hand a player a different finishing position
// from the one the shared screen had just announced (review 2026-08-17, C9;
// PRODUCT_SPEC.md's standings rule).
//
// Ties share the lower rank number and the next rank skips accordingly:
// 10, 10, 8 points ranks 1, 1, 3.
export function rankPlayers(players = []) {
  const sorted = [...players].sort((left, right) => (Number(right.points) || 0) - (Number(left.points) || 0) || String(left.name).localeCompare(String(right.name)));
  let previousPoints = null;
  let rank = 0;
  return sorted.map((player, index) => {
    const points = Number(player.points) || 0;
    if (previousPoints === null || points !== previousPoints) rank = index + 1;
    previousPoints = points;
    // The player object is passed through untouched; callers that print raw
    // point values (the CSV export) must keep seeing what they saw before.
    return { ...player, rank };
  });
}
