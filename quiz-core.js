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
