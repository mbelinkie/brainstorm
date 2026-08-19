import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PRESENTATION_CUE_FRESHNESS_MS, presentationCueDecision } from "../quiz-core.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// C14 — Presentation replayed a long-finished cue after arming or a refresh.
// The command carried no ordering or freshness marker, and the only defence
// was module state that both arming functions reset to null.

const NOW = 1_700_000_000_000;
const cue = (overrides = {}) => ({ id: "cue-1", action: "play", issuedAt: NOW, roomCode: "F7M6VD", quizVersionId: "quiz-1", ...overrides });
const room = (overrides = {}) => ({ roomCode: "F7M6VD", quizVersionId: "quiz-1", now: NOW, ...overrides });

test("a fresh cue plays on a newly armed Presentation", () => {
  // The case arming exists for: the host pressed Play before the tab had its
  // one-time browser gesture, and clicking Enable must not need a second Play.
  const decision = presentationCueDecision(cue({ issuedAt: NOW - 3000 }), room({ freshMount: true }));
  assert.deepEqual(decision, { accepted: true, reason: "accepted" });
});

test("a cue the room finished with long ago never plays on a fresh mount", () => {
  // The reported sequence: host cues clip 7, playback ends, host reveals,
  // Presentation reloads, host clicks Enable -- and clip 7 played over the
  // answer reveal.
  const stale = presentationCueDecision(cue({ issuedAt: NOW - 20 * 60 * 1000 }), room({ freshMount: true }));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale-cue");

  // Just inside and just outside the window.
  assert.equal(presentationCueDecision(cue({ issuedAt: NOW - PRESENTATION_CUE_FRESHNESS_MS }), room({ freshMount: true })).accepted, true);
  assert.equal(presentationCueDecision(cue({ issuedAt: NOW - PRESENTATION_CUE_FRESHNESS_MS - 1 }), room({ freshMount: true })).accepted, false);

  // A cue from a client too old to date its cues cannot be shown to be recent.
  assert.equal(presentationCueDecision(cue({ issuedAt: undefined }), room({ freshMount: true })).reason, "unknown-age");
});

test("only playback-starting cues are held to the freshness window", () => {
  // Re-applying a pause or a volume level on a fresh mount is harmless, and
  // silencing a stale cue must not also silence the volume the host set.
  for (const action of ["pause", "volume"]) {
    assert.equal(presentationCueDecision(cue({ action, issuedAt: NOW - 20 * 60 * 1000 }), room({ freshMount: true })).accepted, true, `${action} must still apply`);
  }
  assert.equal(presentationCueDecision(cue({ action: "restart", issuedAt: NOW - 20 * 60 * 1000 }), room({ freshMount: true })).accepted, false);
});

test("cue A then cue B then a duplicate delivery of A", () => {
  const a = cue({ id: "cue-a", issuedAt: NOW });
  const b = cue({ id: "cue-b", issuedAt: NOW + 1000 });
  let lastApplied = null;

  assert.equal(presentationCueDecision(a, room({ lastApplied, freshMount: true })).accepted, true);
  lastApplied = { id: a.id, issuedAt: a.issuedAt };

  assert.equal(presentationCueDecision(b, room({ lastApplied, now: NOW + 1000 })).accepted, true);
  lastApplied = { id: b.id, issuedAt: b.issuedAt };

  // Supabase can deliver the same broadcast twice, and a reconnect re-reads
  // the persisted command. Neither may replay a cue.
  assert.equal(presentationCueDecision(b, room({ lastApplied, now: NOW + 2000 })).reason, "duplicate");
  assert.equal(presentationCueDecision(a, room({ lastApplied, now: NOW + 2000 })).reason, "out-of-order");
});

test("a cue from another room or another quiz is never acted on", () => {
  assert.equal(presentationCueDecision(cue({ roomCode: "AAAAAA" }), room({ freshMount: true })).reason, "other-room");
  assert.equal(presentationCueDecision(cue({ quizVersionId: "quiz-2" }), room({ freshMount: true })).reason, "other-quiz");
  assert.equal(presentationCueDecision(null, room()).reason, "no-command");
  assert.equal(presentationCueDecision({ action: "play" }, room()).reason, "no-command");
  // An older command with no identity is still usable in the room that has none.
  assert.equal(presentationCueDecision({ id: "c", action: "pause" }, room()).accepted, true);
});

test("cue identity is never allowed to carry a media asset id to a player", () => {
  // publicRoomState() is broadcast to every phone. An asset reference in a
  // cue would put one there, which the payload allowlist forbids.
  const publicState = app.slice(app.indexOf("function publicRoomState"), app.indexOf("function setHostQuestion"));
  assert.ok(publicState.length > 0);
  assert.doesNotMatch(publicState, /mediaAssetId/);

  const identityStart = app.indexOf("function cueIdentity()");
  assert.ok(identityStart > -1, "expected app.js to define cueIdentity");
  const identity = app.slice(identityStart, app.indexOf("\n}", identityStart));
  assert.doesNotMatch(identity, /mediaAssetId/);
  assert.match(identity, /issuedAt: Date\.now\(\)/);
  assert.match(identity, /roomCode,/);
  assert.match(identity, /quizVersionId:/);
});

test("wiring: arming no longer wipes the record of what has been applied", () => {
  // Both arming functions used to reset the handled marker to null, which is
  // what let a finished cue be re-applied by the render that follows arming.
  assert.doesNotMatch(app, /handledPresentationAudioCommand/);
  assert.doesNotMatch(app, /handledPresentationMediaCommand/);

  const armStart = app.indexOf("async function armPresentationAudio()");
  assert.ok(armStart > -1, "expected app.js to define armPresentationAudio");
  const arm = app.slice(armStart, app.indexOf("\n}", armStart));
  assert.doesNotMatch(arm, /lastAppliedAudioCommand = null/);

  for (const name of ["applyPresentationAudioCommand", "applyPresentationMediaCommand"]) {
    const start = app.indexOf(`async function ${name}()`);
    assert.ok(start > -1, `expected app.js to define ${name}`);
    const apply = app.slice(start, app.indexOf("\n}", start));
    assert.match(apply, /presentationCueDecision\(command, \{/, `${name} must consult the freshness predicate`);
    assert.match(apply, /if \(!decision\.accepted\) return;/);
    assert.match(apply, /if \(!prepared\)/, `${name} must not fall through to playback with an unresolved source`);
  }
});
