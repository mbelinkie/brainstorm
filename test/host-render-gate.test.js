import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hostLiveCounts, hostRenderKey } from "../quiz-core.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// A representative Host room state mid-question.
function hostState(overrides = {}) {
  return {
    phase: "open",
    presentationScreen: "question",
    questionId: "q-7",
    question: { id: "q-7", type: "multiple_choice", prompt: "Who sang it?", round: 2, questionInRound: 3 },
    players: [{ id: "p1", name: "Ada", points: 10 }, { id: "p2", name: "Grace", points: 8 }],
    submitted: {},
    doorPicks: [],
    revision: 41,
    timerEndsAt: null,
    timerDurationSeconds: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// The Host must NOT remount when an inbound message carries no host-visible
// structural change. Each of these is something a player (or a cue) does many
// times per question.
// ---------------------------------------------------------------------------

test("a player answer does not change the host render key", () => {
  const before = hostState();
  const after = hostState({ submitted: { p1: "option-b" } });
  assert.equal(hostRenderKey(after), hostRenderKey(before));
});

test("a stream of answers from every player does not change the host render key", () => {
  const before = hostState();
  // multi_fill_in_the_blank auto-submits roughly per keystroke, so one player
  // typing produces many of these in a row.
  let after = hostState();
  for (const answer of ["a", "ab", "abb", "abba"]) after = hostState({ submitted: { p1: answer, p2: answer } });
  assert.equal(hostRenderKey(after), hostRenderKey(before));
});

test("a player joining does not change the host render key", () => {
  const before = hostState();
  const after = hostState({ players: [...before.players, { id: "p3", name: "Alan", points: 0 }] });
  assert.equal(hostRenderKey(after), hostRenderKey(before));
});

test("a door pick does not change the host render key", () => {
  const before = hostState({ phase: "door_choice" });
  const after = hostState({ phase: "door_choice", doorPicks: [{ playerId: "p1", doorId: "door-2" }] });
  assert.equal(hostRenderKey(after), hostRenderKey(before));
});

test("transport-only fields do not change the host render key", () => {
  const before = hostState();
  for (const [field, value] of Object.entries({
    revision: 99,
    audioCommand: { id: "cue-3", action: "play" },
    mediaCommand: { id: "vid-1", action: "play" },
    activeClipId: "clip-2",
    audioVolume: 0.4,
    scoreNotification: { playerId: "p1", points: 5 },
    mediaPlayback: "ended"
  })) {
    assert.equal(hostRenderKey(hostState({ [field]: value })), hostRenderKey(before), `${field} must not remount the host`);
  }
});

test("host render key ignores the order state fields arrive in", () => {
  const a = { phase: "open", questionId: "q-7", players: [] };
  const b = { questionId: "q-7", players: [], phase: "open" };
  assert.equal(hostRenderKey(a), hostRenderKey(b));
});

// ---------------------------------------------------------------------------
// ...but the Host MUST still remount for anything structural. A stale host
// screen is worse than a flickery one.
// ---------------------------------------------------------------------------

test("structural changes still change the host render key", () => {
  const before = hostState();
  const changes = {
    phase: "reveal",
    presentationScreen: "title",
    questionId: "q-8",
    question: { id: "q-8", type: "short_answer", prompt: "Next one" },
    timerEndsAt: "2026-08-18T20:00:00.000Z",
    revealedCorrectOptionId: "option-b",
    targetRoundIndex: 2,
    doorResults: [{ playerId: "p1", multiplier: 2 }]
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(hostRenderKey(hostState({ [field]: value })), hostRenderKey(before), `${field} must remount the host`);
  }
});

// ---------------------------------------------------------------------------
// The counters the Host actually watches must stay live without a remount.
// ---------------------------------------------------------------------------

test("the submitted-answer count tracks arriving submissions", () => {
  assert.deepEqual(hostLiveCounts(hostState()), { submitted: 0, players: 2 });
  assert.deepEqual(hostLiveCounts(hostState({ submitted: { p1: "option-b" } })), { submitted: 1, players: 2 });
  assert.deepEqual(hostLiveCounts(hostState({ submitted: { p1: "option-b", p2: "option-c" } })), { submitted: 2, players: 2 });
});

test("the denominator tracks a late joiner", () => {
  const joined = hostState({ players: [{ id: "p1" }, { id: "p2" }, { id: "p3" }], submitted: { p1: "x" } });
  assert.deepEqual(hostLiveCounts(joined), { submitted: 1, players: 3 });
});

test("host live counts tolerate an empty or partial state", () => {
  assert.deepEqual(hostLiveCounts(undefined), { submitted: 0, players: 0 });
  assert.deepEqual(hostLiveCounts({}), { submitted: 0, players: 0 });
});

// ---------------------------------------------------------------------------
// Wiring contract: the player-driven handlers must patch, not remount.
// ---------------------------------------------------------------------------

function body(name) {
  const start = app.indexOf(name);
  assert.ok(start > -1, `expected app.js to define ${name}`);
  const open = app.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    else if (app[index] === "}") {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  throw new Error(`could not read the body of ${name}`);
}

// Strip line comments so prose explaining why render() is gone does not read
// as a call to it (deploy-manifest.test.js does the same for its examples).
function code(name) {
  return body(name).split("\n").map((line) => line.replace(/\s*\/\/.*$/, "")).join("\n");
}

test("player-driven handlers patch the host instead of rebuilding it", () => {
  for (const name of ["function acceptSubmission(", "function acceptPlayerPresence(", "async function acceptDoorChoice("]) {
    const source = code(name);
    assert.ok(source.includes("patchHostLiveRegions()"), `${name} should patch the host's live regions`);
    assert.ok(!/(?<![a-zA-Z.])render\(\)/.test(source), `${name} must not call render() -- that rebuilds the whole host screen`);
  }
});

test("inbound state messages are gated by the host render key", () => {
  const source = body("function receive(");
  assert.ok(source.includes("hostRenderKey(state)"), "receive() should compare the host render key before remounting");
  assert.ok(source.includes("patchHostLiveRegions()"), "receive() should patch the host when nothing structural changed");
});

test("the host markup exposes the nodes the patch updates", () => {
  for (const hook of ["data-host-submitted-count", "data-host-answer-results", "data-leaderboard", "data-host-doors-board", "data-host-doors-count"]) {
    assert.ok(app.includes(hook), `expected the host markup to carry ${hook}`);
  }
  const patch = body("function patchHostLiveRegions(");
  assert.ok(patch.includes("hostLiveCounts(state)"), "the patch should write the shared live counts");
  assert.ok(!patch.includes("attachEvents()"), "the patch must not re-bind listeners onto nodes that already have them");
});

test("the patch preserves host typing and selection", () => {
  const patch = body("function patchHostLiveRegions(");
  assert.ok(patch.includes("document.activeElement"), "the patch should leave a focused host control alone");
  assert.ok(patch.includes("data-score-player"), "the patch should refresh the manual-score roster in place");
});
