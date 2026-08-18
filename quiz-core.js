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
