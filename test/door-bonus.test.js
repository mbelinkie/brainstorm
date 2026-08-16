import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateQuiz } from "../quiz-validation.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../supabase/migrations/0025_between_round_door_bonus.sql", import.meta.url), "utf8");
const bank = JSON.parse(fs.readFileSync(new URL("../music-trivia.question-bank.json", import.meta.url), "utf8"));

test("recommended doors have equal expected value", () => {
  const expectedValues = bank.betweenRoundBonus.doors.map((door) => door.outcomes.reduce((sum, outcome) => sum + outcome.chancePercent / 100 * outcome.multiplier, 0));
  expectedValues.forEach((value) => assert.equal(Number(value.toFixed(4)), 1.2));
});

test("door validation rejects malformed probabilities and multipliers", () => {
  const quiz = { id: "quiz", title: "Quiz", betweenRoundBonus: structuredClone(bank.betweenRoundBonus), rounds: [{ id: "round", title: "Round", questions: [{ id: "q", type: "single_choice", prompt: "Question?", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"] }] }] };
  assert.deepEqual(validateQuiz(quiz), []);
  quiz.betweenRoundBonus.doors[1].outcomes[0].chancePercent = 40;
  assert.match(validateQuiz(quiz).join(" "), /total 100%/);
  quiz.betweenRoundBonus.doors[1].outcomes[0].chancePercent = 50;
  quiz.betweenRoundBonus.doors[2].outcomes[0].multiplier = 0;
  assert.match(validateQuiz(quiz).join(" "), /positive chances and multipliers/);
});

test("door choices and reveals are server-authoritative and persisted", () => {
  assert.match(api, /choose_live_door/);
  assert.match(api, /reveal_live_door_rewards/);
  assert.match(migration, /unique \(session_id, player_id, target_round_index\)/);
  assert.match(migration, /for update/);
  assert.match(migration, /resolved_multiplier/);
  assert.match(migration, /active_session\.phase::text = 'door_choice'/);
});

test("resolved multiplier applies only to automatic scoring in its target round", () => {
  assert.match(migration, /c\.target_round_index = active_session\.current_round_index/);
  assert.match(migration, /awarded_points := round\(base_awarded_points \* active_multiplier, 2\)/);
  assert.match(migration, /created_by, base_points, multiplier/);
  assert.doesNotMatch(migration.slice(0, migration.indexOf("create or replace function public.lock_and_score_live_question")), /adjust_live_score/);
});

test("all three game surfaces expose the door lifecycle", () => {
  assert.match(app, /function renderHostDoors/);
  assert.match(app, /presentation-card--doors/);
  assert.match(app, /player-main--doors/);
  assert.match(app, /activeMultiplierBadge/);
  assert.match(app, /No door selected/);
});

test("between-round flow reveals one scoreboard, then moves to door choice and the next-round card", () => {
  assert.match(app, /async function startRoundEnd/);
  assert.match(app, /async function startRound/);
  assert.match(app, /End of Round \$\{roundNumber\}/);
  assert.match(app, /Feeling lucky\?/);
  assert.match(app, /Choose your door\./);
  assert.match(app, /if \(state\.presentationScreen === "round_end"\) return doorBonusEnabled\(\) \? openDoorChoice/);
  assert.doesNotMatch(app, /data-show-round-scoreboard/);
  assert.match(app, /isEnd \? "presentation-card--intermission" : "presentation-card--round-start"/);
  assert.doesNotMatch(app, /Check the scoreboard|The scoreboard is up next/);
  assert.match(app, /const scoreboard = isEnd \? `<div class="round-transition-scoreboard">\$\{presentationLeaderboard\(\)\}<\/div>` : ""/);
  assert.match(app, /const scoreboard = isEnd \? `<div class="player-transition-scoreboard">\$\{playerScoreCards\(\)\}<\/div>` : ""/);
  assert.match(styles, /@keyframes round-title-arrival/);
  assert.doesNotMatch(styles, /player-round-transition:has\(.player-transition-splash h1\)\{background:#fff\}/);
  assert.match(app, /function updateDoorChoicePlayingState/);
  assert.doesNotMatch(app.match(/function playerRenderKey\([\s\S]*?\n}\n\nfunction presenterRenderKey/)?.[0] || "", /doorPicks:/);
});

test("advancing within a round opens the next question without a leaderboard", () => {
  const advance = app.slice(app.indexOf("async function advanceQuestion"), app.indexOf("function cueBetweenRoundAudio"));
  assert.match(advance, /nextRound !== roundIndex/);
  assert.match(advance, /state\.phase = "open"/);
  assert.match(advance, /state\.presentationScreen = "question"/);
  assert.doesNotMatch(advance, /presentationScreen = "intermission"/);
});

test("between-round sounds remain optional but validate private asset IDs", () => {
  const quiz = { id: "quiz", title: "Quiz", betweenRoundBonus: structuredClone(bank.betweenRoundBonus), rounds: [{ id: "round", title: "Round", questions: [{ id: "q", type: "single_choice", prompt: "Question?", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"] }] }] };
  quiz.betweenRoundBonus.audio = { doorChoice: { mediaAssetId: "not-a-private-asset" } };
  assert.match(validateQuiz(quiz).join(" "), /Between-round doorChoice sound has an invalid private audio asset ID/);
});
