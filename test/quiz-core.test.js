import test from "node:test";
import assert from "node:assert/strict";
import { correctOptionId, toPlayerQuestion } from "../quiz-core.js";

test("player payload is an explicit allowlist", () => {
  const player = toPlayerQuestion({ id: "q1", type: "image_selection", prompt: "Choose", correctOptionIds: ["a"], hostReveal: "Secret", audio: { url: "https://private.example/clip" }, options: [{ id: "a", label: "Visible", imageAssetId: "asset-1", imageSource: "Private source" }] });
  assert.deepEqual(player, { id: "q1", type: "image_selection", prompt: "Choose", options: [{ id: "a", label: "Visible", imageAssetId: "asset-1" }] });
  assert.equal(JSON.stringify(player).includes("Secret"), false);
  assert.equal(JSON.stringify(player).includes("private.example"), false);
});

test("closest-number targets remain private before reveal", () => {
  const player = toPlayerQuestion({ id: "q-number", type: "closest_number", prompt: "How many?", targetNumber: 8675309, points: 3 });
  assert.deepEqual(player, { id: "q-number", type: "closest_number", prompt: "How many?" });
});

test("multi-blank accepted titles remain private before reveal", () => {
  const player = toPlayerQuestion({ id: "q-audio-blanks", type: "multi_fill_in_the_blank", prompt: "Name each title", pointsPerBlank: 5, clips: [{ id: "clip-1", label: "Intro 1", mediaAssetId: "private-audio", acceptedAnswers: ["Secret Song", "Secrit Song"] }] });
  assert.deepEqual(player, { id: "q-audio-blanks", type: "multi_fill_in_the_blank", prompt: "Name each title", pointsPerBlank: 5, clips: [{ id: "clip-1", label: "Intro 1" }] });
  assert.equal(JSON.stringify(player).includes("Secret Song"), false);
  assert.equal(JSON.stringify(player).includes("private-audio"), false);
});

test("answer-reveal images are excluded from the ordinary player question payload", () => {
  const player = toPlayerQuestion({ id: "q-reveal", type: "short_answer", prompt: "Name it", revealImageAssetId: "private-reveal-asset" });
  assert.equal(JSON.stringify(player).includes("private-reveal-asset"), false);
});

test("presentation-only question and reveal images are excluded from player questions", () => {
  const player = toPlayerQuestion({ id: "q-image", type: "single_choice", prompt: "Who is this?", questionImageAssetId: "question-asset", revealImageAssetId: "reveal-asset", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  assert.equal(JSON.stringify(player).includes("question-asset"), false);
  assert.equal(JSON.stringify(player).includes("reveal-asset"), false);
});

test("correct option resolves modern and legacy definitions", () => {
  assert.equal(correctOptionId({ correctOptionIds: ["b"], options: [{ id: "a" }, { id: "b" }] }), "b");
  assert.equal(correctOptionId({ correctOption: 1, options: [{ id: "a" }, { id: "b" }] }), "b");
});
