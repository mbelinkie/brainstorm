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
