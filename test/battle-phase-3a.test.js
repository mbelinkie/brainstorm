import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { firstPlayableRound, isBattleRound, nextPlayablePosition } from "../quiz-core.js";

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
