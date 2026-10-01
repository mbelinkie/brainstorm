import test from "node:test";
import assert from "node:assert/strict";
import { addPromptToBattleRound, createPromptBattleRound, duplicatePromptBattleRound, isRestorableAuthorDraft, removePromptFromBattleRound, restoredAuthorSelection, setPromptBattleField, promptBattleErrorsByField } from "../prompt-battle-editor.js";
import { validateQuiz } from "../quiz-validation.js";

const questionRound = { id: "round-question", title: "Questions", questions: [{ id: "q1", type: "single_choice", prompt: "Pick?", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"] }] };
const battleRound = {
  id: "round-battle", type: "prompt_battle", title: "Image round",
  prompts: [{ id: "pb-1", text: "Draw a tiny moon." }],
  engine: { defaultProvider: "workers_ai", defaultModel: "model-a", permittedModels: ["model-a"], variants: 2, attemptBudget: 4, steps: 5, resolution: "512", outputFormat: "webp", maxSessionSpendUsd: null, maxSessionGenerations: 100 },
  scoring: { winnerPoints: 40, voterPoints: 2 }
};

test("battle round drafts restore with a safe round selection and preserve their authored shape", () => {
  const bank = { id: "quiz", title: "Quiz", rounds: [questionRound, structuredClone(battleRound)] };
  const draft = { bank, selection: { roundIndex: 1, questionIndex: 12 } };
  assert.equal(isRestorableAuthorDraft(draft), true);
  assert.deepEqual(restoredAuthorSelection(draft), { roundIndex: 1, questionIndex: 0 });
  assert.deepEqual(bank.rounds[1], battleRound);
  assert.deepEqual(validateQuiz(bank), []);
});

test("restored drafts still reject malformed or empty question rounds", () => {
  assert.equal(isRestorableAuthorDraft(null), false);
  assert.equal(isRestorableAuthorDraft({ bank: { rounds: [] } }), false);
  assert.equal(isRestorableAuthorDraft({ bank: { rounds: [{ id: "q", questions: [] }] } }), false);
  assert.equal(isRestorableAuthorDraft({ bank: { rounds: [{ type: "other", questions: [] }] } }), false);
});

test("new battle rounds have the exact editable fields and optional fields stay absent", () => {
  const round = createPromptBattleRound("round-new", "Battle");
  assert.deepEqual(Object.keys(round), ["id", "type", "title", "prompts", "engine", "scoring"]);
  assert.deepEqual(Object.keys(round.engine), ["defaultProvider", "defaultModel", "permittedModels", "variants", "attemptBudget"]);
  assert.deepEqual(round.engine.permittedModels, []);
  assert.equal("steps" in round.engine, false);
  round.prompts[0].text = "A prompt";
  Object.assign(round.engine, { defaultProvider: "workers_ai", defaultModel: "model-a", permittedModels: ["model-a"] });
  assert.deepEqual(validateQuiz({ id: "quiz", title: "Quiz", rounds: [round] }), []);
});

test("battle editor field updates preserve shape and convert authored numeric fields", () => {
  const round = structuredClone(battleRound);
  setPromptBattleField(round, "title", "New title");
  setPromptBattleField(round, "engine.variants", "3");
  setPromptBattleField(round, "engine.steps", "");
  setPromptBattleField(round, "engine.maxSessionSpendUsd", "2.5");
  setPromptBattleField(round, "scoring.voterPoints", "0");
  assert.equal(round.title, "New title");
  assert.equal(round.engine.variants, 3);
  assert.equal("steps" in round.engine, false);
  assert.equal(round.engine.maxSessionSpendUsd, 2.5);
  assert.equal(round.scoring.voterPoints, 0);
  assert.deepEqual(validateQuiz({ id: "quiz", title: "Quiz", rounds: [round] }), []);
});

test("prompt add, edit, delete, and round duplication retain validation and unique IDs", () => {
  const round = structuredClone(battleRound);
  addPromptToBattleRound(round, "pb-new");
  setPromptBattleField(round, "prompts.1.text", "A new image prompt");
  removePromptFromBattleRound(round, 0);
  assert.deepEqual(round.prompts, [{ id: "pb-new", text: "A new image prompt" }]);
  const copy = duplicatePromptBattleRound(round, "round-copy", () => "copy-prompt");
  assert.equal(copy.title, "Image round (copy)");
  assert.equal(copy.prompts[0].id, "copy-prompt");
  assert.deepEqual(validateQuiz({ id: "quiz", title: "Quiz", rounds: [round, copy] }), []);
});

test("authored battle round JSON reloads with all fields unchanged", () => {
  const bank = { id: "quiz", title: "Quiz", rounds: [structuredClone(battleRound)] };
  assert.deepEqual(JSON.parse(JSON.stringify(bank)), bank);
  assert.deepEqual(validateQuiz(bank), []);
});

test("battle field errors reuse validator messages and point at the matching editor fields", () => {
  const round = structuredClone(battleRound);
  round.prompts[0].text = "x".repeat(2049);
  round.engine.variants = 11;
  round.scoring.winnerPoints = 0;
  const errors = promptBattleErrorsByField(round, 1);
  assert.match(errors.prompts, /Round 2, prompt 1 needs prompt text of 2048 characters or fewer/);
  assert.match(errors["engine.variants"], /Round 2 engine needs between 1 and 10 variants/);
  assert.match(errors["scoring.winnerPoints"], /Round 2 needs positive winner points/);
});
