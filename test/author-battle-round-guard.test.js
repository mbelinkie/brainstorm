import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateQuiz, editorUnsupportedRounds } from "../quiz-validation.js";

// validateQuiz accepts a prompt_battle round (0036, slice 2), but the author
// editor can only edit question rounds: renderNav() maps round.questions and
// restoredDraft() discards any draft with a question-less round. Before this
// guard, Apply raw JSON / Import replaced `bank` and saved the draft, then the
// render threw, reported "Not applied", and the next refresh threw the draft
// away. These tests pin the guard that refuses such a quiz before `bank` is
// touched.

const questionRound = { id: "round-1", title: "Round", questions: [{ id: "question-1", type: "single_choice", prompt: "Question?", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"] }] };
const battleRound = {
  id: "round-battle",
  type: "prompt_battle",
  title: "Prompt Battle",
  engine: { defaultProvider: "workers_ai", defaultModel: "@cf/black-forest-labs/flux-1-schnell", permittedModels: ["@cf/black-forest-labs/flux-1-schnell"], variants: 2, attemptBudget: 3 },
  prompts: [{ id: "pb-01", text: "Depict the worst office party ever." }],
  scoring: { winnerPoints: 100, voterPoints: 10 }
};

test("an ordinary question quiz has no editor-unsupported rounds", () => {
  assert.deepEqual(editorUnsupportedRounds({ id: "q", title: "Q", rounds: [questionRound] }), []);
});

test("a valid quiz with a prompt_battle round is reported as editor-unsupported", () => {
  const quiz = { id: "q", title: "Q", rounds: [questionRound, battleRound] };
  assert.deepEqual(validateQuiz(quiz), [], "precondition: the quiz is valid, which is what let it through before");
  const blockers = editorUnsupportedRounds(quiz);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /Round 2/);
  assert.match(blockers[0], /Prompt Battle/);
});

test("the guard tolerates malformed input instead of throwing", () => {
  assert.deepEqual(editorUnsupportedRounds(null), []);
  assert.deepEqual(editorUnsupportedRounds({ rounds: "nope" }), []);
  assert.deepEqual(editorUnsupportedRounds({ rounds: [null, questionRound] }), []);
});

const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
const handler = (id) => {
  const line = author.split("\n").find((text) => text.includes(`$("#${id}").addEventListener(`));
  assert.ok(line, `author.js wires #${id}`);
  return line;
};

for (const id of ["apply-raw", "import-file"]) {
  test(`#${id} refuses editor-unsupported rounds before replacing the bank`, () => {
    const line = handler(id);
    const guardAt = line.indexOf("editorUnsupportedRounds(candidate)");
    const assignAt = line.indexOf("bank = candidate");
    assert.ok(guardAt >= 0, `#${id} calls editorUnsupportedRounds(candidate)`);
    assert.ok(assignAt > guardAt, `#${id} checks the guard before assigning bank`);
  });
}
