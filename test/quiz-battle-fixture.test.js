import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateQuiz } from '../quiz-validation.js';

const root = new URL('../', import.meta.url);
const readJson = (name) => JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'));

test('quiz.battle.sample.json is a valid single-round Prompt Battle quiz', () => {
  const quiz = readJson('quiz.battle.sample.json');
  const errors = validateQuiz(quiz);
  assert.deepEqual(errors, []);
  assert.equal(quiz.rounds.length, 1);
  const round = quiz.rounds[0];
  assert.equal(round.type, 'prompt_battle');
  assert.equal(round.prompts.length, 6);
  assert.equal(new Set(round.prompts.map((p) => p.id)).size, 6);
  for (const prompt of round.prompts) {
    assert.ok(prompt.text && prompt.text.trim().length > 0);
    assert.ok(prompt.text.length <= 2048);
  }
  assert.equal(round.engine.defaultProvider, 'kaplan_proxy');
  assert.equal(round.engine.defaultModel, 'gemini-3.1-flash-image');
  assert.deepEqual(round.engine.permittedModels, ['gemini-3.1-flash-image']);
  assert.equal(round.engine.variants, 2);
  assert.equal(round.engine.attemptBudget, 3);
  assert.equal(round.engine.maxSessionSpendUsd, 20);
  assert.deepEqual(round.scoring, { winnerPoints: 100, voterPoints: 10 });
});

test('the two compatibility fixtures still validate with the shared validator', () => {
  for (const name of ['quiz.sample.json', 'music-trivia.question-bank.json']) {
    const quiz = readJson(name);
    const errors = validateQuiz(quiz);
    assert.deepEqual(errors, [], `${name} should remain valid`);
  }
});

test('a malformed Prompt Battle clone with a duplicate prompt ID is rejected', () => {
  const quiz = readJson('quiz.battle.sample.json');
  // Clone only what we mutate; the real fixture remains untouched.
  const malformed = structuredClone(quiz);
  const [firstPrompt] = malformed.rounds[0].prompts;
  malformed.rounds[0].prompts[1].id = firstPrompt.id;
  const errors = validateQuiz(malformed);
  assert.ok(errors.length > 0, 'duplicate prompt ID must produce a validation error');
  assert.ok(errors.some((error) => error.includes('duplicate prompt ID')), 'expected duplicate prompt ID error');
});
