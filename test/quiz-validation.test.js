import test from "node:test";
import assert from "node:assert/strict";
import { validateQuiz } from "../quiz-validation.js";

const validQuiz = { id: "quiz", title: "Quiz", rounds: [{ id: "round-1", title: "Round", questions: [{ id: "question-1", type: "single_choice", prompt: "Question?", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"] }] }] };
test("valid choice quiz passes author validation", () => assert.deepEqual(validateQuiz(validQuiz), []));
test("duplicate question IDs and bad answer keys fail validation", () => { const invalid = structuredClone(validQuiz); invalid.rounds[0].questions.push({ ...invalid.rounds[0].questions[0], correctOptionIds: ["missing"] }); const errors = validateQuiz(invalid); assert.match(errors.join(" "), /duplicate question ID/); assert.match(errors.join(" "), /invalid answer key/); });
test("missing title, prompt, or points block publication", () => { const invalid = structuredClone(validQuiz); invalid.title = ""; invalid.rounds[0].questions[0].prompt = ""; invalid.rounds[0].questions[0].points = 0; const errors = validateQuiz(invalid); assert.match(errors.join(" "), /Quiz title is required/); assert.match(errors.join(" "), /needs a player prompt/); assert.match(errors.join(" "), /needs positive points/); });
test("closest-number questions require a finite target", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "closest", type: "closest_number", prompt: "How many?", points: 3, targetNumber: 42 }; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].targetNumber = "not a number"; assert.match(validateQuiz(quiz).join(" "), /valid target number/); });
test("matching questions use points per pair instead of question points", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "matching", type: "matching", prompt: "Match these", pointsPerPair: 1, clips: [{ id: "one", label: "One" }, { id: "two", label: "Two" }], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctPairs: { one: "a", two: "b" } }; assert.deepEqual(validateQuiz(quiz), []); });
test("title-page captions are validated as bounded normalized cues", () => { const quiz = structuredClone(validQuiz); quiz.titlePage = { audio: { captionSourceName: "theme.ass", captions: [{ startMs: 0, endMs: 1200, text: "Hello", karaoke: [{ startMs: 0, endMs: 500, startIndex: 0, endIndex: 5 }] }] } }; assert.deepEqual(validateQuiz(quiz), []); quiz.titlePage.audio.captions[0].karaoke[0].endIndex = 6; assert.match(validateQuiz(quiz).join(" "), /captions/); });
test("title-page presenter is an optional bounded string", () => { const quiz = structuredClone(validQuiz); quiz.titlePage = { presenter: "Team Trivia presents" }; assert.deepEqual(validateQuiz(quiz), []); quiz.titlePage.presenter = 42; assert.match(validateQuiz(quiz).join(" "), /presenter/); });
test("multi-blank audio questions require accepted answers and points per blank", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "audio-blanks", type: "multi_fill_in_the_blank", prompt: "Name each title", pointsPerBlank: 5, clips: [{ id: "one", label: "Intro 1", acceptedAnswers: ["Song One"] }, { id: "two", label: "Intro 2", acceptedAnswers: ["Song Two", "Song Too"] }] }; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].clips[1].acceptedAnswers = []; assert.match(validateQuiz(quiz).join(" "), /accepted answers for every clip/); });

// The rules below used to live only in author.js's private copy of validateQuiz.
// They are the rules that actually gate Publish, so they belong in the shared
// module every surface and every test uses.
const UUID = "5f6a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b";
test("unsupported question types are rejected", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0].type = "spelling_bee"; assert.match(validateQuiz(quiz).join(" "), /unsupported question type/); });
test("fill-in-the-blank questions need accepted answers for every blank", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "blanks", type: "fill_in_the_blank", prompt: "___ is the title", points: 2, blanks: [{ acceptedAnswers: ["Answer"] }] }; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].blanks = []; assert.match(validateQuiz(quiz).join(" "), /accepted answers for every blank/); quiz.rounds[0].questions[0].blanks = [{ acceptedAnswers: [" "] }]; assert.match(validateQuiz(quiz).join(" "), /accepted answers for every blank/); });
test("arrange-in-order questions need a complete unique order key", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "order", type: "arrange_in_order", prompt: "Order these", points: 2, items: [{ id: "one", label: "First" }, { id: "two", label: "Second" }], correctOrder: ["one", "two"] }; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].correctOrder = ["one", "one"]; assert.match(validateQuiz(quiz).join(" "), /complete, unique order answer key/); quiz.rounds[0].questions[0].correctOrder = ["one", "missing"]; assert.match(validateQuiz(quiz).join(" "), /complete, unique order answer key/); });
test("categorize questions need exactly two categories and a resolvable assignment key", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "sorting", type: "categorize", prompt: "Sort these", points: 2, categories: [{ id: "cat-a", label: "A" }, { id: "cat-b", label: "B" }], items: [{ id: "item-1", label: "One" }, { id: "item-2", label: "Two" }], correctCategories: { "item-1": "cat-a", "item-2": "cat-b" } }; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].correctCategories["item-2"] = "cat-c"; assert.match(validateQuiz(quiz).join(" "), /two categories and a complete valid assignment key/); quiz.rounds[0].questions[0].correctCategories["item-2"] = "cat-b"; quiz.rounds[0].questions[0].categories.push({ id: "cat-c", label: "C" }); assert.match(validateQuiz(quiz).join(" "), /two categories and a complete valid assignment key/); });
test("matching pair keys must resolve to real option IDs", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0] = { id: "matching", type: "matching", prompt: "Match these", pointsPerPair: 1, clips: [{ id: "one", label: "One" }, { id: "two", label: "Two" }], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctPairs: { one: "a", two: "missing" } }; assert.match(validateQuiz(quiz).join(" "), /complete clips, options, pair key/); quiz.rounds[0].questions[0].correctPairs.two = "b"; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].clips[1].label = ""; assert.match(validateQuiz(quiz).join(" "), /complete clips, options, pair key/); });
test("private audio asset IDs are validated on questions and finale cues", () => { const quiz = structuredClone(validQuiz); quiz.rounds[0].questions[0].audio = { mediaAssetId: UUID }; quiz.finale = { audio: { podium: { mediaAssetId: UUID } } }; assert.deepEqual(validateQuiz(quiz), []); quiz.rounds[0].questions[0].audio.mediaAssetId = "audio-clip"; assert.match(validateQuiz(quiz).join(" "), /invalid private media asset ID/); quiz.rounds[0].questions[0].audio.mediaAssetId = UUID; quiz.finale.audio.podium.mediaAssetId = "not-a-uuid"; assert.match(validateQuiz(quiz).join(" "), /Finale podium has an invalid private audio asset ID/); });

// Prompt Battle round type — base spec section 4, as amended by the free-engine
// addendum section 5. Additive: a round with no `type` is the ordinary question
// round every existing quiz uses, which is why both compatibility fixtures still
// validate unchanged (proved in test/quiz-fixtures.test.js).
const validBattleRound = {
  id: "round-battle",
  type: "prompt_battle",
  title: "Prompt Battle",
  engine: {
    defaultProvider: "workers_ai",
    defaultModel: "@cf/black-forest-labs/flux-1-schnell",
    permittedModels: ["@cf/black-forest-labs/flux-1-schnell", "google/gemini-3.1-flash-image"],
    variants: 2,
    attemptBudget: 3,
    steps: 4,
    resolution: "512",
    outputFormat: "webp",
    maxSessionSpendUsd: null,
    maxSessionGenerations: 150
  },
  prompts: [
    { id: "pb-01", text: "Depict the worst office party ever." },
    { id: "pb-02", text: "Illustrate Monday morning as a natural disaster." }
  ],
  scoring: { winnerPoints: 100, voterPoints: 10 }
};
const quizWithBattle = () => { const quiz = structuredClone(validQuiz); quiz.rounds.push(structuredClone(validBattleRound)); return quiz; };

test("a valid prompt_battle round passes validation and needs no questions array", () => {
  const quiz = quizWithBattle();
  assert.equal(quiz.rounds[1].questions, undefined);
  assert.deepEqual(validateQuiz(quiz), []);
});

test("a prompt_battle round with no prompts is rejected", () => {
  const quiz = quizWithBattle();
  quiz.rounds[1].prompts = [];
  assert.match(validateQuiz(quiz).join(" "), /needs at least one battle prompt/);
  delete quiz.rounds[1].prompts;
  assert.match(validateQuiz(quiz).join(" "), /needs at least one battle prompt/);
});

test("battle prompts need an ID, bounded text, and no duplicate IDs", () => {
  const quiz = quizWithBattle();
  quiz.rounds[1].prompts[1].id = "pb-01";
  assert.match(validateQuiz(quiz).join(" "), /duplicate prompt ID/);
  quiz.rounds[1].prompts[1].id = "pb-02";
  quiz.rounds[1].prompts[1].text = "";
  assert.match(validateQuiz(quiz).join(" "), /needs prompt text of 2048 characters or fewer/);
  // 2048 is session_battle_matchups.prompt_text's check constraint in 0036, so
  // an over-long prompt must fail at publish rather than at open_battle_round.
  quiz.rounds[1].prompts[1].text = "x".repeat(2049);
  assert.match(validateQuiz(quiz).join(" "), /needs prompt text of 2048 characters or fewer/);
});

test("the battle engine block needs a provider, a model, and a permitted-model list containing it", () => {
  const quiz = quizWithBattle();
  delete quiz.rounds[1].engine;
  assert.match(validateQuiz(quiz).join(" "), /needs an engine block/);

  const missingDefault = quizWithBattle();
  missingDefault.rounds[1].engine.defaultModel = "google/not-permitted";
  assert.match(validateQuiz(missingDefault).join(" "), /default model must be one of its permitted models/);

  const noModels = quizWithBattle();
  noModels.rounds[1].engine.permittedModels = [];
  assert.match(validateQuiz(noModels).join(" "), /needs at least one permitted model/);

  const noProvider = quizWithBattle();
  noProvider.rounds[1].engine.defaultProvider = "  ";
  assert.match(validateQuiz(noProvider).join(" "), /needs a default provider/);
});

test("battle variants, attempt budget, and steps are bounded whole numbers", () => {
  const quiz = quizWithBattle();
  quiz.rounds[1].engine.variants = 0;
  assert.match(validateQuiz(quiz).join(" "), /between 1 and 10 variants/);
  quiz.rounds[1].engine.variants = 11;
  assert.match(validateQuiz(quiz).join(" "), /between 1 and 10 variants/);
  quiz.rounds[1].engine.variants = 2;
  quiz.rounds[1].engine.attemptBudget = 0;
  assert.match(validateQuiz(quiz).join(" "), /positive attempt budget/);
  quiz.rounds[1].engine.attemptBudget = 3;
  // Workers AI flux-1-schnell accepts steps 1-8 (addendum section 4.1).
  quiz.rounds[1].engine.steps = 9;
  assert.match(validateQuiz(quiz).join(" "), /steps must be between 1 and 8/);
});

test("a null spend cap means no monetary cap and is accepted; a negative one is not", () => {
  // Addendum section 5: null = no cap, 0 = generation disabled, positive = the
  // ceiling. The superseded draft used 0.0 for "no cap", which inverts this.
  const quiz = quizWithBattle();
  quiz.rounds[1].engine.maxSessionSpendUsd = null;
  assert.deepEqual(validateQuiz(quiz), []);
  quiz.rounds[1].engine.maxSessionSpendUsd = 0;
  assert.deepEqual(validateQuiz(quiz), []);
  quiz.rounds[1].engine.maxSessionSpendUsd = 25;
  assert.deepEqual(validateQuiz(quiz), []);
  quiz.rounds[1].engine.maxSessionSpendUsd = -1;
  assert.match(validateQuiz(quiz).join(" "), /spend cap must be null or a number of 0 or more/);
});

test("resolution and outputFormat stay optional, because workers_ai ignores both", () => {
  const quiz = quizWithBattle();
  delete quiz.rounds[1].engine.resolution;
  delete quiz.rounds[1].engine.outputFormat;
  assert.deepEqual(validateQuiz(quiz), []);
});

test("a prompt_battle round needs winner and voter points", () => {
  const quiz = quizWithBattle();
  delete quiz.rounds[1].scoring;
  assert.match(validateQuiz(quiz).join(" "), /needs a scoring block/);
  const zeroWinner = quizWithBattle();
  zeroWinner.rounds[1].scoring.winnerPoints = 0;
  assert.match(validateQuiz(zeroWinner).join(" "), /needs positive winner points/);
  const negativeVoter = quizWithBattle();
  negativeVoter.rounds[1].scoring.voterPoints = -1;
  assert.match(validateQuiz(negativeVoter).join(" "), /needs voter points of 0 or more/);
  // Casting no vote is worth nothing, but a round may legitimately award
  // nothing for voting.
  const zeroVoter = quizWithBattle();
  zeroVoter.rounds[1].scoring.voterPoints = 0;
  assert.deepEqual(validateQuiz(zeroVoter), []);
});

test("an unknown round type is rejected, and an absent one is still the ordinary question round", () => {
  const quiz = quizWithBattle();
  quiz.rounds[1].type = "karaoke_battle";
  assert.match(validateQuiz(quiz).join(" "), /unsupported round type/);
  assert.deepEqual(validateQuiz(validQuiz), [], "a round with no type must keep validating unchanged");
});
