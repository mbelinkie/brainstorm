import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateQuiz } from "../quiz-validation.js";
import { tallyQuestionResults, toPlayerQuestion } from "../quiz-core.js";

// CLAUDE.md names `quiz.sample.json` and `music-trivia.question-bank.json` as
// compatibility fixtures: "Old quizzes still load ... validate against them via
// quiz-validation.js before shipping a schema change." Until now neither file
// was read by any test, so nothing would have noticed a schema change breaking
// them — and `quiz.sample.json` had in fact been broken for some time (three
// rounds with no questions, and a matching finale with an empty answer key).
//
// These tests run the real shared helpers over the real bundled files rather
// than asserting anything about their source text.
//
// NOTE for whoever merges the two `validateQuiz` implementations: this imports
// `quiz-validation.js`, the module `prepare-deploy.mjs` ships and the existing
// tests already use. The editor currently runs its own private copy inside
// `author.js`, which exports nothing and so cannot be imported here. Both
// copies accept both fixtures today. When the two are merged, re-point this
// import at whichever module survives.

const root = new URL("../", import.meta.url);
const fixtureNames = ["quiz.sample.json", "music-trivia.question-bank.json"];
const fixtures = fixtureNames.map((name) => [name, JSON.parse(fs.readFileSync(new URL(name, root), "utf8"))]);

// Fields that decide or disclose the answer. None may survive into a player
// payload, at any nesting depth.
const answerKeyFields = [
  "correctOptionIds",
  "correctOption",
  "correctPairs",
  "correctCategories",
  "correctOrder",
  "acceptedAnswers",
  "blanks",
  "targetNumber",
  "hostReveal",
  "audio",
  "audioAssetId",
  "video",
  "revealImageAssetId",
  "questionImageAssetId",
  "points",
  "pointsPerPair"
];

function everyQuestion(quiz) {
  return quiz.rounds.flatMap((round) => round.questions.map((question) => [round.id, question]));
}

function keysAnywhere(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((entry) => keysAnywhere(entry, found));
  else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      found.add(key);
      keysAnywhere(nested, found);
    }
  }
  return found;
}

// Build the submission a player would send if they got the question entirely
// right, derived from the question's own answer key.
function correctAnswerFor(question) {
  switch (question.type) {
    case "single_choice":
    case "true_false":
    case "image_selection":
      return question.correctOptionIds[0];
    case "multiple_choice":
      return [...question.correctOptionIds];
    case "short_answer":
      return question.acceptedAnswers[0];
    case "fill_in_the_blank":
      return question.blanks[0].acceptedAnswers[0];
    case "closest_number":
      return String(question.targetNumber);
    case "arrange_in_order":
      return Object.fromEntries(question.correctOrder.map((itemId, index) => [itemId, index + 1]));
    case "matching":
      return { ...question.correctPairs };
    case "categorize":
      return { ...question.correctCategories };
    case "multi_fill_in_the_blank":
      return Object.fromEntries(question.clips.map((clip) => [clip.id, clip.acceptedAnswers[0]]));
    default:
      throw new Error(`no correct-answer builder for question type "${question.type}"`);
  }
}

// A submission that is definitely wrong for the same question.
function wrongAnswerFor(question) {
  switch (question.type) {
    case "single_choice":
    case "true_false":
    case "image_selection": {
      const wrong = question.options.find((option) => !question.correctOptionIds.includes(option.id));
      assert.ok(wrong, `${question.id} has no incorrect option to choose`);
      return wrong.id;
    }
    case "multiple_choice":
      return ["not-an-option-id"];
    case "short_answer":
    case "fill_in_the_blank":
      return "definitely not the answer";
    case "closest_number":
      return String(Number(question.targetNumber) + 1000);
    case "arrange_in_order":
      return Object.fromEntries([...question.correctOrder].reverse().map((itemId, index) => [itemId, index + 1]));
    case "matching":
      return Object.fromEntries(question.clips.map((clip) => [clip.id, "not-an-option-id"]));
    case "categorize":
      return Object.fromEntries(question.items.map((item) => [item.id, "not-a-category-id"]));
    case "multi_fill_in_the_blank":
      return Object.fromEntries(question.clips.map((clip) => [clip.id, "definitely not the answer"]));
    default:
      throw new Error(`no incorrect-answer builder for question type "${question.type}"`);
  }
}

for (const [name, quiz] of fixtures) {
  test(`${name} passes validation`, () => {
    assert.deepEqual(validateQuiz(quiz), []);
  });

  test(`${name} has no empty round`, () => {
    // An empty round is not merely invalid: the host state machine has no way
    // out of one. `startRound` calls `setHostQuestion(n, 0)`, which returns
    // false and leaves the phase untouched, so "next round" silently does
    // nothing. Keep every round playable.
    assert.ok(quiz.rounds.length > 0, `${name} has no rounds`);
    for (const round of quiz.rounds) {
      assert.ok(Array.isArray(round.questions) && round.questions.length > 0, `round "${round.id}" in ${name} has no questions`);
    }
  });

  test(`${name} exposes no answer-key field to players`, () => {
    for (const [roundId, question] of everyQuestion(quiz)) {
      const player = toPlayerQuestion(question);
      const exposed = keysAnywhere(player);
      for (const field of answerKeyFields) {
        assert.ok(!exposed.has(field), `${name} round "${roundId}" question "${question.id}" leaks "${field}" to players`);
      }
    }
  });

  test(`${name} keeps private media identifiers out of player payloads`, () => {
    const players = everyQuestion(quiz).map(([, question]) => toPlayerQuestion(question));

    // Structural half: option artwork is the only media reference a player is
    // ever allowed to hold. Post-0029 `can_access_live_media` lets a joined
    // player redeem exactly the active question's option images; every other
    // asset reference — question audio, reveal art, matching clip audio — is
    // host- and Presentation-only.
    for (const player of players) {
      for (const key of keysAnywhere(player)) {
        assert.ok(!/assetid$/i.test(key) || key === "imageAssetId", `${name} question "${player.id}" exposes "${key}" to players`);
      }
      for (const clip of player.clips || []) assert.deepEqual(Object.keys(clip).sort(), ["id", "label"], `${name} question "${player.id}" sends more than a clip's id and label`);
    }

    // Value half: real sentinels lifted out of the fixtures themselves. Asset
    // IDs that double as a public `id` somewhere in the document (the bundled
    // bank's legacy `audio.assetId` reuses its question IDs) cannot be
    // distinguished by value, so they are excluded here; the structural half
    // above still covers them.
    const payload = JSON.stringify(players);
    const publicIds = collectValues(quiz, (key) => key === "id");
    const optionArtwork = new Set(everyQuestion(quiz).flatMap(([, question]) => (question.options || []).map((option) => option.imageAssetId).filter(Boolean)));
    const privateAssetIds = [...collectValues(quiz, (key) => /assetid$/i.test(key))].filter((assetId) => !publicIds.has(assetId) && !optionArtwork.has(assetId));
    assert.ok(privateAssetIds.length > 0, `${name} has no private asset ID to use as a sentinel`);
    for (const assetId of privateAssetIds) {
      assert.ok(!payload.includes(assetId), `${name} leaks private asset ID "${assetId}" to players`);
    }
  });

  test(`${name} scores every question from its own answer key`, () => {
    // The point of a compatibility fixture is that it can still be played.
    // For each question, replay the answer its key describes and one that
    // contradicts it, and check the shipped comparison rules agree.
    //
    // What this proves: every question's key is complete, internally
    // consistent, and scoreable by the comparison rules `tallyQuestionResults`
    // mirrors from 0030. It is what fails first if a question type loses its
    // branch, or a fixture gains a type nothing can score.
    // What it does not prove: that the key is factually right. The correct
    // answer is derived from the key, so a wrong-but-coherent key still passes.
    for (const [roundId, question] of everyQuestion(quiz)) {
      const where = `${name} round "${roundId}" question "${question.id}" (${question.type})`;
      const right = tallyQuestionResults(question, { "player-1": correctAnswerFor(question) });
      assert.equal(right.totalSubmitted, 1, `${where}: expected one submission`);
      assert.equal(right.correctCount, 1, `${where}: the question's own answer key does not score as correct`);

      const mixed = tallyQuestionResults(question, { "player-1": correctAnswerFor(question), "player-2": wrongAnswerFor(question) });
      assert.equal(mixed.totalSubmitted, 2, `${where}: expected two submissions`);
      assert.equal(mixed.correctCount, 1, `${where}: a wrong answer was scored as correct`);
    }
  });

  test(`${name} attaches artwork only where players may redeem it`, () => {
    // `toPlayerQuestion` copies `items` and `categories` through unfiltered,
    // while `can_access_live_media` only authorizes a player for the active
    // question's *option* artwork. Artwork on a categorize item or an ordering
    // card would therefore reach the phone and then 403, rendering broken.
    // Until those two paths agree, the fixtures must not exercise the gap.
    for (const [roundId, question] of everyQuestion(quiz)) {
      for (const key of ["items", "categories"]) {
        for (const entry of question[key] || []) {
          assert.ok(!entry.imageAssetId, `${name} round "${roundId}" question "${question.id}" attaches artwork to a "${key}" entry, which players cannot load`);
        }
      }
    }
  });
}

function collectValues(value, matches, found = new Set()) {
  if (Array.isArray(value)) value.forEach((entry) => collectValues(entry, matches, found));
  else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (matches(key) && typeof nested === "string" && nested) found.add(nested);
      collectValues(nested, matches, found);
    }
  }
  return found;
}
