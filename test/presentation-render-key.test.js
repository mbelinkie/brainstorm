import test from "node:test";
import assert from "node:assert/strict";
import { presenterRenderKey } from "../quiz-core.js";

// A Presentation re-render revokes every private-image object URL, re-issues a
// Worker fetch per image and restarts every entrance animation, so the render
// key decides whether the shared screen flashes mid-question. These assert on
// the key's actual behavior; test/reliability-contract.test.js's regex over
// app.js source could only see that *some* fields were destructured, not which.

function roomState(overrides = {}) {
  return {
    phase: "open",
    presentationScreen: "question",
    questionId: "q1",
    question: { id: "q1", type: "single_choice", prompt: "Who?" },
    players: [{ id: "p1", name: "Ada", points: 10 }],
    doorPicks: [],
    doorResults: [],
    scoreNotification: null,
    screenHistory: ["title"],
    revision: 4,
    activeClipId: null,
    audioCommand: null,
    audioVolume: 1,
    mediaCommand: null,
    submitted: {},
    ...overrides
  };
}

const LATE_JOINER = [{ id: "p1", name: "Ada", points: 10 }, { id: "p2", name: "Bela", points: 0 }];
const NOTIFICATION = { playerName: "Ada", points: 5, reason: "Host award", expiresAt: "2099-01-01T00:00:00.000Z" };

test("a late player joining does not remount the question", () => {
  for (const [phase, screen] of [["open", "question"], ["locked", "question"], ["reveal", "question"]]) {
    const before = presenterRenderKey(roomState({ phase, presentationScreen: screen }));
    const after = presenterRenderKey(roomState({ phase, presentationScreen: screen, players: LATE_JOINER }));
    assert.equal(before, after, `a roster change remounted the ${phase} screen`);
  }
});

test("a score notification neither arriving nor expiring remounts the reveal", () => {
  const quiet = presenterRenderKey(roomState({ phase: "reveal" }));
  const celebrating = presenterRenderKey(roomState({ phase: "reveal", players: LATE_JOINER, scoreNotification: NOTIFICATION }));
  assert.equal(quiet, celebrating);
});

test("host navigation history never reaches the shared screen", () => {
  assert.equal(presenterRenderKey(roomState()), presenterRenderKey(roomState({ screenHistory: ["title", "round_start", "question"] })));
});

test("audio and video transport still stay out of the key", () => {
  const before = presenterRenderKey(roomState());
  const after = presenterRenderKey(roomState({
    revision: 99,
    activeClipId: "clip-2",
    audioCommand: { id: "cmd-2", action: "play" },
    audioVolume: 0.4,
    mediaCommand: { id: "m-2", action: "play" },
    submitted: { p1: "a" }
  }));
  assert.equal(before, after);
});

test("scenes that show the roster still redraw when a score changes", () => {
  for (const screen of ["title", "round_end", "final_podium", "final_scores"]) {
    const before = presenterRenderKey(roomState({ presentationScreen: screen }));
    const after = presenterRenderKey(roomState({ presentationScreen: screen, players: LATE_JOINER }));
    assert.notEqual(before, after, `${screen} ignored a roster change it renders`);
  }
});

test("the final leaderboard redraws when scores change", () => {
  // phase `complete` renders presentationLeaderboard without going through one
  // of the finale screens.
  const before = presenterRenderKey(roomState({ phase: "complete", presentationScreen: "intermission" }));
  const after = presenterRenderKey(roomState({ phase: "complete", presentationScreen: "intermission", players: LATE_JOINER }));
  assert.notEqual(before, after);
});

test("door picks redraw the doors, and nothing else", () => {
  for (const phase of ["door_choice", "door_reveal"]) {
    const before = presenterRenderKey(roomState({ phase, presentationScreen: "question" }));
    const after = presenterRenderKey(roomState({ phase, presentationScreen: "question", doorPicks: [{ playerId: "p1", doorId: "d1" }] }));
    assert.notEqual(before, after, `${phase} ignored a door pick it renders`);
  }
  const before = presenterRenderKey(roomState());
  const after = presenterRenderKey(roomState({ doorPicks: [{ playerId: "p1", doorId: "d1" }] }));
  assert.equal(before, after, "a stale door pick remounted a question screen");
});

test("real scene changes still remount", () => {
  const base = presenterRenderKey(roomState());
  assert.notEqual(base, presenterRenderKey(roomState({ phase: "reveal" })));
  assert.notEqual(base, presenterRenderKey(roomState({ presentationScreen: "title" })));
  assert.notEqual(base, presenterRenderKey(roomState({ questionId: "q2", question: { id: "q2", type: "matching", prompt: "Match" } })));
  assert.notEqual(base, presenterRenderKey(roomState({ doorResults: [{ playerId: "p1", multiplier: 2 }] })));
});

test("the key is stable for an unchanged room state", () => {
  assert.equal(presenterRenderKey(roomState()), presenterRenderKey(roomState()));
  assert.equal(presenterRenderKey(roomState({ presentationScreen: "title" })), presenterRenderKey(roomState({ presentationScreen: "title" })));
});
