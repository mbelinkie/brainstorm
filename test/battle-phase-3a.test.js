import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { firstPlayableRound, hostSavedPosition, isBattleRound, nextPlayablePosition } from "../quiz-core.js";

// Prompt Battle slice 3a. Spec:
// docs/superpowers/specs/2026-09-23-prompt-battle-slice-3a-design.md

const withQuestions = (count) => ({ questions: Array.from({ length: count }, (_, index) => ({ id: `q${index}` })) });
const BATTLE = { type: "prompt_battle", title: "Prompt Battle", prompts: [{ id: "p", text: "Draw it." }] };
const EMPTY = { questions: [] };

test("isBattleRound recognises only prompt_battle rounds", () => {
  assert.equal(isBattleRound(BATTLE), true);
  assert.equal(isBattleRound(withQuestions(2)), false);
  assert.equal(isBattleRound(null), false);
  assert.equal(isBattleRound({ type: "something_else" }), false);
});

test("firstPlayableRound treats a battle round as playable", () => {
  assert.equal(firstPlayableRound([EMPTY, BATTLE, withQuestions(1)], 0), 1);
  assert.equal(firstPlayableRound([withQuestions(1), BATTLE], 1), 1);
  assert.equal(firstPlayableRound([EMPTY, EMPTY], 0), -1, "an empty round that is not a battle round is still skipped");
});

test("nextPlayablePosition enters a battle round from the previous round", () => {
  const rounds = [withQuestions(2), BATTLE, withQuestions(1)];
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 0, questionIndex: 1 }), { roundIndex: 1, questionIndex: 0, battle: true, roundChanged: true });
});

test("nextPlayablePosition leaves a battle round instead of re-entering it", () => {
  const rounds = [withQuestions(2), BATTLE, EMPTY, withQuestions(1)];
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 1, questionIndex: 0 }), { roundIndex: 3, questionIndex: 0, roundChanged: true });
  assert.equal(nextPlayablePosition([withQuestions(1), BATTLE], { roundIndex: 1, questionIndex: 0 }), null, "a battle round as the last round leads to the finale");
});

test("nextPlayablePosition from the start can land on a battle round", () => {
  assert.deepEqual(nextPlayablePosition([BATTLE, withQuestions(1)]), { roundIndex: 0, questionIndex: 0, battle: true, roundChanged: true });
});

test("question rounds walk exactly as before, including over both compatibility fixtures", () => {
  const rounds = [withQuestions(2), EMPTY, withQuestions(1)];
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 0, questionIndex: 0 }), { roundIndex: 0, questionIndex: 1, roundChanged: false });
  assert.deepEqual(nextPlayablePosition(rounds, { roundIndex: 0, questionIndex: 1 }), { roundIndex: 2, questionIndex: 0, roundChanged: true });
  for (const file of ["../quiz.sample.json", "../music-trivia.question-bank.json"]) {
    const quiz = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), "utf8"));
    const total = quiz.rounds.reduce((sum, round) => sum + (round.questions || []).length, 0);
    let visited = 0;
    for (let position = nextPlayablePosition(quiz.rounds); position; position = nextPlayablePosition(quiz.rounds, position)) {
      assert.equal(position.battle, undefined, `${file} has no battle round`);
      visited += 1;
    }
    assert.equal(visited, total, `${file}: every question is visited exactly once`);
  }
});

test("hostSavedPosition records the battle round while the host is on it", () => {
  const stale = { round: 2, questionInRound: 5 }; // the previous round's last question
  assert.deepEqual(hostSavedPosition({ phase: "lobby", battleRoundIndex: 2, question: stale }), { roundIndex: 2, questionIndex: 0 });
  assert.deepEqual(hostSavedPosition({ phase: "battle_prompt", battleRoundIndex: 2, question: stale }), { roundIndex: 2, questionIndex: 0 });
});

test("hostSavedPosition keeps today's rule outside a battle round", () => {
  assert.deepEqual(hostSavedPosition({ phase: "open", battleRoundIndex: null, question: { round: 3, questionInRound: 4 } }), { roundIndex: 2, questionIndex: 3 });
  assert.deepEqual(hostSavedPosition({ phase: "door_choice", targetRoundIndex: 4, question: { round: 3, questionInRound: 4 } }), { roundIndex: 4, questionIndex: 3 });
  assert.deepEqual(hostSavedPosition({}), { roundIndex: 0, questionIndex: 0 });
});

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const fn = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app.js defines ${name}`);
  return app.slice(start, app.indexOf("\n}\n", start) + 2);
};

test("hostStatePayload saves battle_prompt and the hostSavedPosition result", () => {
  const body = fn("hostStatePayload");
  assert.match(body, /battle_prompt: "battle_prompt"/);
  assert.match(body, /hostSavedPosition\(state\)/);
});

const BATTLE_FIELDS = ["battleRoundIndex", "battleMatchupIndex", "battleMatchupCount"];

test("publicRoomState forwards exactly the three battle integers and nothing else battle-related", () => {
  const body = fn("publicRoomState");
  for (const field of BATTLE_FIELDS) assert.match(body, new RegExp(`${field}: Number\\.isInteger\\(state\\.${field}\\) \\? state\\.${field} : null`));
  assert.doesNotMatch(body, /battleRoundPanel|matchups|promptText|entrants|shuffleSeed/);
});

test("the player render key includes the battle fields", () => {
  const body = fn("playerRenderKey");
  for (const field of BATTLE_FIELDS) assert.match(body, new RegExp(`${field}: roomState\\?\\.${field}`));
});

test("a host or Presentation reload maps battle_prompt back instead of falling to lobby", () => {
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  assert.match(reload, /complete: "complete", battle_prompt: "battle_prompt" \}\)\[savedRoom\.phase\]/);
});

test("startRound enters a battle round without a question and without auto-advancing", () => {
  const body = fn("startRound");
  assert.match(body, /isBattleRound\(hostQuizDefinition\.rounds\[roundToStart\]\)/);
  assert.match(body, /enterBattleRound\(roundToStart\)/);
  assert.match(body, /if \(!Number\.isInteger\(state\.battleRoundIndex\)\) scheduleRoundStartAdvance\(\);/);
});

test("setHostQuestion and startFinale leave the battle round", () => {
  for (const name of ["setHostQuestion", "startFinale"]) {
    const body = fn(name);
    assert.match(body, /battleRoundIndex: null, battleMatchupIndex: null, battleMatchupCount: null/, `${name} clears the battle fields`);
  }
});

test("opening adopts battle_prompt, persists, and never puts the pairing on state", () => {
  const body = fn("openBattleRoundFromHost");
  assert.match(body, /roomApi\.openBattleRound\(\{ roomCode, hostSecret \}\)/);
  assert.match(body, /state\.phase = "battle_prompt";/);
  assert.match(body, /state\.presentationScreen = "battle_prompt";/);
  assert.match(body, /state\.battleMatchupIndex = 0;/);
  assert.match(body, /await persistHostState\(\);/);
  assert.match(body, /battleRoundPanel\.state = pairing;/);
  assert.doesNotMatch(body, /state\.(matchups|pairing|battleRoundPanel)\b|state = \{[^}]*pairing/);
});

test("End battle round walks on to the round-end card or the finale", () => {
  const body = fn("endBattleRound");
  assert.match(body, /nextPlayablePosition\(hostQuizDefinition\?\.rounds, \{ roundIndex: battleIndex, questionIndex: 0 \}\)/);
  assert.match(body, /startRoundEnd\(next\.roundIndex\)/);
  assert.match(body, /startFinale\(\)/);
});

test("N on a battle round opens it rather than a stale question, and does nothing in battle_prompt", () => {
  const body = fn("showNextScreen");
  assert.match(body, /if \(state\.phase === "battle_prompt"\) return;/);
  assert.match(body, /if \(Number\.isInteger\(state\.battleRoundIndex\)\) return openBattleRoundFromHost\(\);\s*return setPhase\("open"\);/);
});

test("P does not rewind out of a battle round in 3a", () => {
  assert.match(fn("showPreviousScreen"), /if \(Number\.isInteger\(state\.battleRoundIndex\)\) return;/);
});

test("the host has a battle_prompt screen and re-fetches the pairing after a reload", () => {
  // The whole battle round, start card included, uses the battle screen, so
  // the previous round's last question is never drawn on the host.
  assert.match(fn("renderHost"), /if \(Number\.isInteger\(state\.battleRoundIndex\)\) \{ renderHostBattle\(\); return; \}/);
  assert.doesNotMatch(fn("renderHost"), /battlePairingPanel\(\)/, "renderHost no longer renders the pairing panel");
  const battle = fn("renderHostBattle");
  assert.match(battle, /const opened = state\.phase === "battle_prompt";/);
  assert.match(battle, /opened \? [^:]*data-battle-end-round/, "End battle round is shown only once the round is open");
  assert.equal((battle.match(/data-battle-end-round/g) || []).length, 1);
  assert.match(battle, /Open the round when everyone has joined\. Pairing locks the roster\./);
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  assert.match(reload, /if \(view === "host" && state\.phase === "battle_prompt"\) refreshBattlePairing\(\);/);
});

test("P never rewinds into a battle_prompt screen", () => {
  assert.match(fn("showPreviousScreen"), /if \(!previous \|\| previous\.phase === "battle_prompt"\) return;/);
});

test("Open refuses a pairing for a different round than the host is on", () => {
  // Two adjacent battle rounds: a second N while startRound(B) is still saving
  // gets round A's existing pairing back from the idempotency guard.
  const body = fn("openBattleRoundFromHost");
  const guard = body.search(/if \(Number\(pairing\?\.roundIndex\) !== state\.battleRoundIndex\)/);
  assert.ok(guard >= 0, "openBattleRoundFromHost checks the pairing's roundIndex");
  assert.ok(guard < body.indexOf("battleRoundPanel.state = pairing;"), "the check comes before the pairing is adopted");
  assert.ok(guard < body.indexOf('state.phase = "battle_prompt";'), "the check comes before battle_prompt is set");
  assert.match(body, /The room was still saving the new round\. Press Open battle round again\./);
});

test("the battle screen keeps the host's session controls", () => {
  const body = fn("renderHostBattle");
  assert.match(body, /\$\{hostUtilityControls\(\)\}\$\{manualScoreControls\(\)\}\$\{leaderboard\(\)\}/);
});

test("players see a holding screen in battle_prompt with no prompt, pairing or image", () => {
  const body = fn("renderPlayer");
  const start = body.indexOf('if (state.phase === "battle_prompt")');
  assert.ok(start >= 0, "renderPlayer has a battle_prompt branch");
  assert.ok(start < body.indexOf("state.question.prompt") || body.indexOf("state.question.prompt") === -1, "the battle branch returns before any question rendering");
  const branch = body.slice(start, body.indexOf("return;", start));
  assert.match(branch, /Your prompt is on its way/);
  assert.doesNotMatch(branch, /<img|promptText|battleRoundPanel|matchups/);
});

test("Presentation shows the round and matchup count in battle_prompt, never images", () => {
  const presenter = fn("renderPresenter");
  assert.match(presenter, /state\.phase === "battle_prompt" \? "Prompt Battle"/);
  assert.match(presenter, /: state\.phase === "battle_prompt"\s*\? presenterBattlePrompt\(\)/);
  const card = fn("presenterBattlePrompt");
  assert.match(card, /battleMatchupCount/);
  assert.doesNotMatch(card, /<img|promptText|matchups|imageAssetId/);
});
