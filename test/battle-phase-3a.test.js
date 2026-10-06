import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { firstPlayableRound, hostSavedPosition, isBattleRound, nextPlayablePosition } from "../quiz-core.js";
import { battleRosterRows, battleSpendView, publicBattleProgress } from "../battle-roster.js";

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

test("publicRoomState forwards the three battle integers and only the aggregate progress", () => {
  const body = fn("publicRoomState");
  for (const field of BATTLE_FIELDS) assert.match(body, new RegExp(`${field}: Number\\.isInteger\\(state\\.${field}\\) \\? state\\.${field} : null`));
  // The private roster reaches public state through one aggregate projection
  // and through nothing else.
  assert.equal((body.match(/battleRoundPanel/g) || []).length, 1, "publicRoomState reads the private battle panel in exactly one place");
  assert.ok(body.includes("battleProgress: publicBattleProgress(battleRoundPanel.state)"), "publicRoomState projects the aggregate through the extracted helper");
  assert.doesNotMatch(body, /matchups|promptText|entrants|shuffleSeed/);
  // Runtime, not source: with a private roster full of battle-only fields the
  // projection still carries two integer counts and nothing else.
  const privateRoster = { matchups: [{ promptText: "PRIVATE_PROMPT", entrants: [
    { playerName: "PRIVATE_CREATOR", playerId: "PRIVATE_ID", submitted: true, attemptsUsed: 1, generations: [{ status: "complete", assetIds: ["PRIVATE_ASSET"], playerPrompt: "PRIVATE_PROMPT" }] },
    { playerName: "Second entrant", submitted: false, attemptsUsed: 0, generations: [{ status: "pending" }] }
  ] }] };
  const progress = publicBattleProgress(privateRoster);
  assert.deepEqual(progress, { submitted: 1, total: 2 });
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE|Second entrant/);
});

// Issue #27 moved the host roster behind battle-roster.js and publishes only
// the aggregate. These run the extracted helpers instead of reading app.js.
test("issue #27: roster labels, attempts, spend and the public projection use server-reported values", () => {
  const roster = {
    sessionSpendUsd: 1.25,
    maxSessionSpendUsd: 9.5,
    matchups: [{ entrants: [
      { playerName: "Ada", attemptsUsed: 2, submitted: true, generations: [{ status: "complete", assetIds: ["asset"] }] },
      { playerName: "Grace", attemptsUsed: 1, submitted: false, generations: [{ status: "pending" }] },
      { playerName: "Alan", attemptsUsed: 0, submitted: false, generations: [] },
      { playerName: "Bo", attemptsUsed: 0, submitted: false, generations: [{ status: "failed" }] },
      { playerName: "Cy", attemptsUsed: 1, submitted: false, generations: [{ status: "blocked" }] },
      { playerName: "Dee", attemptsUsed: 1, submitted: false, generations: [{ status: "complete", assetIds: ["asset"] }] }
    ] }]
  };
  const rows = battleRosterRows(roster);
  assert.deepEqual(rows.map((row) => row.status), ["Submitted", "Generating", "Not started", "Ready to retry", "Ready to retry", "Ready to submit"]);
  assert.deepEqual(rows.map((row) => row.attemptsUsed), [2, 1, 0, 0, 1, 1]);
  assert.equal(rows[3].refunded, true, "a refunded attempt is not mistaken for a player who never started");
  assert.deepEqual(publicBattleProgress(roster), { submitted: 1, total: 6 });
  const spend = battleSpendView(roster);
  assert.equal(spend.spend, 1.25);
  assert.equal(spend.cap, 9.5);
  assert.equal(spend.capLabel, "$9.50 cap");
  const uncapped = battleSpendView({ sessionSpendUsd: 1.25, maxSessionSpendUsd: null });
  assert.equal(uncapped.cap, null);
  assert.match(uncapped.capLabel, /no configured cap/i);
  // Submitted wins over a pending generation, and a complete generation with
  // no asset is not Ready to submit.
  assert.equal(battleRosterRows({ matchups: [{ entrants: [{ playerName: "Locked", attemptsUsed: 2, submitted: true, generations: [{ status: "pending" }] }] }] })[0].status, "Submitted");
  assert.equal(battleRosterRows({ matchups: [{ entrants: [{ playerName: "Empty", attemptsUsed: 1, submitted: false, generations: [{ status: "complete", assetIds: [] }] }] }] })[0].status, "Ready to retry");
});

test("the player render key includes the battle fields", () => {
  const body = fn("playerRenderKey");
  for (const field of BATTLE_FIELDS) assert.match(body, new RegExp(`${field}: roomState\\?\\.${field}`));
});

test("a host or Presentation reload maps the battle phases back instead of falling to lobby", () => {
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  assert.ok(reload.includes('battle_prompt: "battle_prompt", battle_review: "battle_review"'), "the saved-phase map carries both battle phases");
  assert.ok(reload.includes('savedPhaseMap[savedRoom.phase] || "lobby"'), "an unknown saved phase still falls back to lobby");
  assert.ok(reload.includes("phase: savedPhase"), "the server's phase wins over the saved public screen");
  assert.ok(reload.includes('["battle_prompt", "battle_review"].includes(savedPhase)'), "a room locked on the server restores into review");
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

test("N on a battle round opens it rather than a stale question, and does nothing in battle_prompt or battle_review", () => {
  const body = fn("showNextScreen");
  assert.ok(body.includes('if (state.phase === "battle_prompt" || state.phase === "battle_review") return;'), "N does nothing once submissions are open or locked");
  const openIdx = body.indexOf("return openBattleRoundFromHost();");
  const phaseIdx = body.indexOf('return setPhase("open");');
  assert.ok(openIdx >= 0 && phaseIdx > openIdx, "a battle round is opened, never a stale question");
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
  assert.ok(battle.includes('const opened = state.phase === "battle_prompt" || review;'), "the battle screen is open in prompt and review");
  assert.match(battle, /opened \? [^:]*data-battle-end-round/, "End battle round is shown only once the round is open");
  assert.equal((battle.match(/data-battle-end-round/g) || []).length, 1);
  assert.match(battle, /Open the round when everyone has joined\. Pairing locks the roster\./);
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  assert.ok(reload.includes('if (view === "host" && ["battle_prompt", "battle_review"].includes(state.phase)) refreshBattlePairing();'), "a reload into either battle phase re-reads the private roster");
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
  assert.match(branch, /shell\(`[^`]*`, true\);/, "the holding screen is wrapped in the player shell");
});

test("Presentation shows the round and matchup count in battle_prompt, never images", () => {
  const presenter = fn("renderPresenter");
  assert.match(presenter, /state\.phase === "battle_prompt" \? "Prompt Battle"/);
  assert.match(presenter, /: state\.phase === "battle_prompt"\s*\? presenterBattlePrompt\(\)/);
  const card = fn("presenterBattlePrompt");
  assert.match(card, /battleMatchupCount/);
  assert.doesNotMatch(card, /<img|promptText|matchups|imageAssetId/);
});

test("a save that recovers re-renders the battle screen so Open is enabled again", () => {
  // battlePairingPanel() disables Open while hostStateSaveFailure is set, and
  // refreshHostSyncNotice() only patches the banner.
  const helper = fn("renderBattleAfterSaveRecovered");
  assert.match(helper, /if \(view === "host" && Number\.isInteger\(state\.battleRoundIndex\)\) render\(\);/);
  const clears = app.match(/(?<!let )hostStateSaveFailure = null;/g) || [];
  const rerenders = app.match(/hostStateSaveFailure = null; refreshHostSyncNotice\(\); renderBattleAfterSaveRecovered\(\);/g) || [];
  assert.ok(clears.length >= 1);
  assert.equal(rerenders.length, clears.length, "every place that clears the save failure re-renders a battle screen");
  assert.match(fn("saveHostState"), /renderBattleAfterSaveRecovered\(\);/);
});

test("Refresh roster goes through refreshBattlePairing, which refuses another round's roster", () => {
  const events = fn("attachEvents");
  assert.ok(events.includes('querySelectorAll("[data-battle-refresh-pairing]")'), "the roster control is wired");
  assert.ok(events.includes("refreshBattlePairing()"), "the roster control reloads the private roster");
  assert.doesNotMatch(app, /runBattleRoundCall/);
  const body = fn("refreshBattlePairing");
  assert.ok(body.includes("if (battleRefreshInFlight) return;"), "a second refresh never overlaps the first");
  const requestRound = body.indexOf("const requestRound = state.battleRoundIndex;");
  const guard = body.indexOf("state.battleRoundIndex !== requestRound");
  assert.ok(requestRound >= 0, "refreshBattlePairing records the round it asked about");
  assert.ok(guard > requestRound, "refreshBattlePairing refuses a response for another round");
  assert.ok(guard < body.indexOf("requestPanel.state = result;"), "the check comes before the roster is adopted");
});

test("a reload into battle_prompt also restores the battle_prompt screen", () => {
  // open_battle_round writes phase but not presentationScreen to sessions.state.
  const reload = app.slice(app.indexOf("const savedRoom = await roomApi.getHostRoomState"), app.indexOf("restoreHostSubmissions();", app.indexOf("const savedRoom = await roomApi.getHostRoomState")));
  const merge = reload.indexOf("state = { ...state, ...savedRoom.state");
  const fix = reload.indexOf('if (state.phase === "battle_prompt" || state.phase === "battle_review") state.presentationScreen = state.phase;');
  assert.ok(fix > merge && merge >= 0, "the screen is set after the saved state is merged");
  assert.ok(fix < reload.indexOf('if (["door_choice", "door_reveal"].includes(state.phase))'), "directly after the merge");
});

test("Refresh roster patches pending feedback and reports a missing host secret", () => {
  const body = fn("refreshBattlePairing");
  assert.ok(body.includes("!Number.isInteger(state.battleRoundIndex)"));
  assert.ok(body.includes("if (battleRefreshInFlight) return;"), "refreshBattlePairing refuses overlapping calls");
  assert.ok(body.includes('if (!hostSecret) { battleRoundPanel.error = "Host authorization is required."; patchBattlePairingPanel(); return; }'));
  const call = body.indexOf("await roomApi.getHostBattleState");
  const before = body.slice(0, call);
  const tail = body.slice(call);
  assert.ok(call >= 0);
  assert.ok(before.includes("requestPanel.busy = true;"), "busy is set before the await");
  assert.ok(before.includes('requestPanel.error = "";'), "the previous error is cleared before the await");
  assert.ok(before.includes("if (!silent) patchBattlePairingPanel();"), "pending feedback is patched before the await");
  assert.ok(tail.includes("requestPanel.busy = false;"), "the busy flag is always cleared");
  assert.ok(tail.includes("patchBattlePairingPanel();"), "feedback is patched once the call settles");
});
