import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateQuiz } from "../quiz-validation.js";
import { isRestorableAuthorDraft } from "../prompt-battle-editor.js";

const questionRound = { id: "round-1", title: "Round", questions: [{ id: "question-1", type: "single_choice", prompt: "Question?", points: 1, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionIds: ["a"] }] };
const battleRound = {
  id: "round-battle", type: "prompt_battle", title: "Prompt Battle",
  engine: { defaultProvider: "workers_ai", defaultModel: "model-a", permittedModels: ["model-a"], variants: 2, attemptBudget: 3 },
  prompts: [{ id: "pb-01", text: "Depict the worst office party ever." }], scoring: { winnerPoints: 100, voterPoints: 10 }
};

test("a mixed quiz with a Prompt Battle round validates and survives browser draft recovery", () => {
  const bank = { id: "q", title: "Quiz", rounds: [questionRound, battleRound] };
  const draft = { bank, selection: { roundIndex: 1, questionIndex: 0 } };
  assert.deepEqual(validateQuiz(bank), []);
  assert.equal(isRestorableAuthorDraft(draft), true);
  assert.deepEqual(bank.rounds[1], battleRound);
});

test("Apply raw JSON and Import keep battle rounds instead of rejecting them", () => {
  const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
  for (const id of ["apply-raw", "import-file"]) {
    const line = author.split("\n").find((text) => text.includes(`$("#${id}").addEventListener(`));
    assert.ok(line, `author.js wires #${id}`);
    assert.match(line, /validateQuiz\(candidate\)/);
    assert.doesNotMatch(line, /editorUnsupportedRounds/);
  }
});

test("the author editor renders battle rounds without reading questions", () => {
  const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
  assert.match(author, /round\.type === "prompt_battle"/);
  assert.match(author, /\(round\.questions \|\| \[\]\)/);
  assert.match(author, /function renderPromptBattleEditor\(/);
  assert.match(author, /function addPromptBattleRound\(/);
});
