import test from "node:test";
import assert from "node:assert/strict";
import { correctOptionId, isPlayerSessionExpired, normalizedAudioVolume, PLAYER_IDENTITY_ROOM_LIMIT, PLAYER_SESSION_TTL_MS, playerIdentityForRoom, readPlayerIdentityStore, tallyQuestionResults, toPlayerQuestion, writePlayerIdentityForRoom } from "../quiz-core.js";

test("player payload is an explicit allowlist", () => {
  const player = toPlayerQuestion({ id: "q1", type: "image_selection", prompt: "Choose", correctOptionIds: ["a"], hostReveal: "Secret", audio: { url: "https://private.example/clip" }, options: [{ id: "a", label: "Visible", imageAssetId: "asset-1", imageSource: "Private source" }] });
  assert.deepEqual(player, { id: "q1", type: "image_selection", prompt: "Choose", options: [{ id: "a", label: "Visible", imageAssetId: "asset-1" }] });
  assert.equal(JSON.stringify(player).includes("Secret"), false);
  assert.equal(JSON.stringify(player).includes("private.example"), false);
});

test("closest-number targets remain private before reveal", () => {
  const player = toPlayerQuestion({ id: "q-number", type: "closest_number", prompt: "How many?", targetNumber: 8675309, points: 3 });
  assert.deepEqual(player, { id: "q-number", type: "closest_number", prompt: "How many?" });
});

test("multi-blank accepted titles remain private before reveal", () => {
  const player = toPlayerQuestion({ id: "q-audio-blanks", type: "multi_fill_in_the_blank", prompt: "Name each title", pointsPerBlank: 5, clips: [{ id: "clip-1", label: "Intro 1", mediaAssetId: "private-audio", acceptedAnswers: ["Secret Song", "Secrit Song"] }] });
  assert.deepEqual(player, { id: "q-audio-blanks", type: "multi_fill_in_the_blank", prompt: "Name each title", pointsPerBlank: 5, clips: [{ id: "clip-1", label: "Intro 1" }] });
  assert.equal(JSON.stringify(player).includes("Secret Song"), false);
  assert.equal(JSON.stringify(player).includes("private-audio"), false);
});

test("answer-reveal images are excluded from the ordinary player question payload", () => {
  const player = toPlayerQuestion({ id: "q-reveal", type: "short_answer", prompt: "Name it", revealImageAssetId: "private-reveal-asset" });
  assert.equal(JSON.stringify(player).includes("private-reveal-asset"), false);
});

test("presentation-only question and reveal images are excluded from player questions", () => {
  const player = toPlayerQuestion({ id: "q-image", type: "single_choice", prompt: "Who is this?", questionImageAssetId: "question-asset", revealImageAssetId: "reveal-asset", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  assert.equal(JSON.stringify(player).includes("question-asset"), false);
  assert.equal(JSON.stringify(player).includes("reveal-asset"), false);
});

test("correct option resolves modern and legacy definitions", () => {
  assert.equal(correctOptionId({ correctOptionIds: ["b"], options: [{ id: "a" }, { id: "b" }] }), "b");
  assert.equal(correctOptionId({ correctOption: 1, options: [{ id: "a" }, { id: "b" }] }), "b");
});

test("audio volume clamps to a valid gain and defaults to full volume", () => {
  assert.equal(normalizedAudioVolume(0.35), 0.35);
  assert.equal(normalizedAudioVolume(-2), 0);
  assert.equal(normalizedAudioVolume(2), 1);
  assert.equal(normalizedAudioVolume(undefined), 1);
  assert.equal(normalizedAudioVolume("not a number"), 1);
});

// A saved player identity (name/logo) should let a phone rejoin after an
// accidental tab close, but not resurface on a later, unrelated game.
test("a player identity within the session TTL is not expired", () => {
  const now = Date.parse("2026-08-17T20:00:00Z");
  assert.equal(isPlayerSessionExpired(now - 1000, now), false); // rescanned the QR a second later
  assert.equal(isPlayerSessionExpired(now - PLAYER_SESSION_TTL_MS, now), false); // right at the boundary
});

test("a player identity older than the session TTL is expired", () => {
  const now = Date.parse("2026-08-17T20:00:00Z");
  assert.equal(isPlayerSessionExpired(now - PLAYER_SESSION_TTL_MS - 1, now), true); // just past the boundary
  assert.equal(isPlayerSessionExpired(Date.parse("2026-08-16T20:00:00Z"), now), true); // an earlier game, a day later
});

test("a player identity with no recorded activity is treated as expired", () => {
  // localStorage.getItem() returns null for a key it never wrote (a device
  // that has never joined, or one whose identity predates this TTL).
  assert.equal(isPlayerSessionExpired(null), true);
  assert.equal(isPlayerSessionExpired(undefined), true);
  assert.equal(isPlayerSessionExpired("not-a-timestamp"), true);
});

// The saved identity is keyed by room code, so the TTL above and the room a
// phone is scanning into are enforced independently. The reported bug was a
// phone that played room ABC123 an hour ago -- comfortably inside the TTL --
// reusing that name and logo when it scanned the QR for an unrelated room.
const NOW = Date.parse("2026-08-18T21:00:00Z");
const identityStore = (rooms) => JSON.stringify(rooms);
const roomA = { playerId: "token-a", playerName: "Belinkie", logoKey: "avatar-03", lastActiveAt: NOW - 60 * 60 * 1000 };

test("rejoining the same room inside the TTL restores the saved name, logo, and token", () => {
  // The must-not-regress case: a phone that screen-locked, had its tab
  // evicted, or closed the tab mid-game rescans the SAME QR and has to land
  // back on its existing score rather than on a blank join screen.
  const restored = playerIdentityForRoom(identityStore({ ABC123: roomA }), "ABC123", NOW);
  assert.equal(restored.playerName, "Belinkie");
  assert.equal(restored.logoKey, "avatar-03");
  assert.equal(restored.playerId, "token-a", "the player token must survive, or the server issues a new player row");
});

test("scanning a DIFFERENT room inside the TTL offers no saved identity", () => {
  // The reported bug. One hour idle, so isPlayerSessionExpired() alone would
  // happily hand back the old name; keying by room is what stops it.
  assert.equal(isPlayerSessionExpired(roomA.lastActiveAt, NOW), false);
  assert.equal(playerIdentityForRoom(identityStore({ ABC123: roomA }), "XYZ789", NOW), null);
});

test("rejoining the same room past the TTL offers no saved identity", () => {
  const stale = { ...roomA, lastActiveAt: NOW - PLAYER_SESSION_TTL_MS - 1 };
  assert.equal(playerIdentityForRoom(identityStore({ ABC123: stale }), "ABC123", NOW), null);
});

test("joining a second room retains the first room's identity rather than clobbering it", () => {
  // A host running two rooms back to back, or a player who opens the wrong QR
  // code and then rescans the right one, must still be able to return to the
  // first room and find their existing score attached to their token.
  const afterJoiningB = writePlayerIdentityForRoom(identityStore({ ABC123: roomA }), "XYZ789", { playerId: "token-b", playerName: "Belinkie", logoKey: "avatar-07" }, NOW);
  assert.equal(playerIdentityForRoom(afterJoiningB, "XYZ789", NOW).playerId, "token-b");
  const backInA = playerIdentityForRoom(afterJoiningB, "ABC123", NOW);
  assert.equal(backInA.playerId, "token-a");
  assert.equal(backInA.playerName, "Belinkie");
  assert.equal(backInA.lastActiveAt, roomA.lastActiveAt, "room A's own TTL clock must not be extended by activity in room B");
});

test("each room's identity expires on its own clock", () => {
  const raw = identityStore({ ABC123: roomA, XYZ789: { ...roomA, playerId: "token-b", lastActiveAt: NOW - PLAYER_SESSION_TTL_MS - 1 } });
  assert.ok(playerIdentityForRoom(raw, "ABC123", NOW));
  assert.equal(playerIdentityForRoom(raw, "XYZ789", NOW), null);
});

test("writing an identity prunes expired rooms and caps how many are kept", () => {
  const rooms = { EXPIRE: { ...roomA, lastActiveAt: NOW - PLAYER_SESSION_TTL_MS - 1 } };
  for (let index = 0; index < PLAYER_IDENTITY_ROOM_LIMIT + 4; index += 1) rooms[`ROOM${index}`] = { ...roomA, playerId: `token-${index}`, lastActiveAt: NOW - index * 1000 };
  const written = writePlayerIdentityForRoom(identityStore(rooms), "NEWEST", { playerId: "token-new", playerName: "Belinkie", logoKey: "avatar-01" }, NOW);
  const kept = Object.keys(JSON.parse(written));
  assert.equal(kept.length, PLAYER_IDENTITY_ROOM_LIMIT);
  assert.equal(kept[0], "NEWEST");
  assert.ok(!kept.includes("EXPIRE"), "an expired room entry must not survive a write");
  assert.ok(!kept.includes("ROOM11"), "the least recently active rooms are evicted first");
});

test("the legacy unkeyed identity is adopted onto a room without extending its TTL", () => {
  // app.js's one-shot migration passes the legacy activity timestamp through
  // rather than restamping to now, so an adopted identity still expires when
  // the original 6-hour gap runs out instead of getting a free extension.
  const legacyAt = NOW - 5 * 60 * 60 * 1000;
  const migrated = writePlayerIdentityForRoom("", "ABC123", { playerId: "legacy-token", playerName: "Belinkie", logoKey: "avatar-03", lastActiveAt: legacyAt }, NOW);
  assert.equal(playerIdentityForRoom(migrated, "ABC123", NOW).lastActiveAt, legacyAt);
  assert.equal(playerIdentityForRoom(migrated, "ABC123", legacyAt + PLAYER_SESSION_TTL_MS + 1), null);
});

test("an unreadable identity store degrades to no saved identity instead of throwing", () => {
  for (const raw of ["", null, undefined, "not json", "[1,2,3]", '"a string"', '{"ABC123":null}']) {
    assert.equal(playerIdentityForRoom(raw, "ABC123", NOW), null);
    assert.deepEqual(readPlayerIdentityStore(raw, NOW), {});
  }
});

test("an entry with no player token is not a resumable identity", () => {
  // app.js persists the room entry as soon as the join screen renders, before
  // a name exists; that half-written entry must not skip the join screen.
  assert.equal(playerIdentityForRoom(identityStore({ ABC123: { playerId: "", playerName: "", logoKey: "", lastActiveAt: NOW } }), "ABC123", NOW), null);
});

test("a missing room code never resolves to another room's identity", () => {
  assert.equal(playerIdentityForRoom(identityStore({ ABC123: roomA }), "", NOW), null);
  assert.equal(playerIdentityForRoom(identityStore({ ABC123: roomA }), undefined, NOW), null);
});

// tallyQuestionResults() is the host's post-reveal "who got it right"
// summary. It mirrors supabase/migrations/0030_multi_fill_in_the_blank_
// scoring.sql's per-type comparison rules against the raw answers the host
// already collected in state.submitted — it never assigns points itself.

test("multi_fill_in_the_blank reports a per-clip breakdown, normalizing punctuation and case like the scoring migration", () => {
  const question = { type: "multi_fill_in_the_blank", clips: [
    { id: "clip-1", label: "Intro 1", acceptedAnswers: ["Clocks"] },
    { id: "clip-2", label: "Intro 2", acceptedAnswers: ["A Thousand Miles"] }
  ] };
  const submissions = {
    p1: { "clip-1": "clocks", "clip-2": "a thousand miles" }, // exact after normalizing
    p2: { "clip-1": "Clocks!!", "clip-2": "Someone Like You" }, // punctuation-insensitive match, wrong second blank
    p3: { "clip-1": "Piano Man", "clip-2": "" }
  };
  const results = tallyQuestionResults(question, submissions);
  assert.equal(results.totalSubmitted, 3);
  assert.deepEqual(results.parts, [
    { partId: "clip-1", label: "Intro 1", correctCount: 2 },
    { partId: "clip-2", label: "Intro 2", correctCount: 1 }
  ]);
  // Only p1 got every blank right.
  assert.equal(results.correctCount, 1);
});

test("matching reports a per-pair breakdown", () => {
  const question = { type: "matching", clips: [{ id: "c1", label: "Sample A" }, { id: "c2", label: "Sample B" }], correctPairs: { c1: "opt-a", c2: "opt-b" } };
  const submissions = {
    p1: { c1: "opt-a", c2: "opt-b" }, // both right
    p2: { c1: "opt-a", c2: "opt-a" }, // one right
    p3: { c1: "opt-b", c2: "opt-a" } // none right
  };
  const results = tallyQuestionResults(question, submissions);
  assert.deepEqual(results.parts, [
    { partId: "c1", label: "Sample A", correctCount: 2 },
    { partId: "c2", label: "Sample B", correctCount: 1 }
  ]);
  assert.equal(results.correctCount, 1);
});

test("categorize reports a per-item breakdown", () => {
  const question = { type: "categorize", items: [{ id: "i1", label: "Item 1" }, { id: "i2", label: "Item 2" }], correctCategories: { i1: "cat-a", i2: "cat-b" } };
  const submissions = { p1: { i1: "cat-a", i2: "cat-b" }, p2: { i1: "cat-b", i2: "cat-b" } };
  const results = tallyQuestionResults(question, submissions);
  assert.deepEqual(results.parts, [
    { partId: "i1", label: "Item 1", correctCount: 1 },
    { partId: "i2", label: "Item 2", correctCount: 2 }
  ]);
  assert.equal(results.correctCount, 1);
});

test("single-answer question types have no part breakdown and count exact correctness", () => {
  const singleChoice = tallyQuestionResults({ type: "single_choice", correctOptionIds: ["b"] }, { p1: "b", p2: "a", p3: "b" });
  assert.equal(singleChoice.parts, null);
  assert.equal(singleChoice.correctCount, 2);
  assert.equal(singleChoice.totalSubmitted, 3);

  const multipleChoice = tallyQuestionResults({ type: "multiple_choice", correctOptionIds: ["a", "c"] }, { p1: ["c", "a"], p2: ["a"] });
  assert.equal(multipleChoice.correctCount, 1); // order-independent set match

  const shortAnswer = tallyQuestionResults({ type: "short_answer", acceptedAnswers: ["Clocks"] }, { p1: "clocks!", p2: "Coldplay" });
  assert.equal(shortAnswer.correctCount, 1);

  const arrange = tallyQuestionResults({ type: "arrange_in_order", correctOrder: ["x", "y", "z"] }, { p1: { x: "1", y: "2", z: "3" }, p2: { x: "1", y: "3", z: "2" } });
  assert.equal(arrange.correctCount, 1);
});

test("closest_number credits everyone tied for the smallest distance to the target", () => {
  const results = tallyQuestionResults({ type: "closest_number", targetNumber: 100 }, { p1: "90", p2: "110", p3: "50", p4: "not a number" });
  // p1 and p2 are both 10 away, the closest of the valid guesses.
  assert.equal(results.correctCount, 2);
  assert.equal(results.totalSubmitted, 4);
});

test("tallyQuestionResults never throws on an empty submissions map", () => {
  const results = tallyQuestionResults({ type: "single_choice", correctOptionIds: ["a"] }, {});
  assert.deepEqual(results, { totalSubmitted: 0, correctCount: 0, parts: null });
});
