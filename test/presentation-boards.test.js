import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Behavioral tests for app.js's answer boards.
//
// test/presentation-layout.test.js asserts against app.js's *source text* with
// regexes, which is why a literal, uninterpolated `${...}` string survived in
// matchingBoard for as long as it did: the regexes matched the literal happily
// (review 2026-08-17-app-author.md, F7). These tests instead render the board
// and assert on the produced markup.
//
// app.js is a browser module with top-level DOM side effects, so it cannot be
// imported under node. Each board function is a self-contained top-level
// function whose only free variables are `state` and a handful of helpers, so
// we lift the function's source out of app.js and evaluate it against stubs.
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function boardRenderer(name, { state = {}, selected = {} } = {}) {
  const start = app.indexOf(`\nfunction ${name}(`);
  assert.notEqual(start, -1, `${name} not found in app.js — did it get renamed?`);
  const end = app.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name} in app.js`);
  const source = app.slice(start + 1, end + 3);
  const escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const dragCard = (item) => `<span class="drag-card" data-item-id="${escapeHtml(item.id)}">${escapeHtml(item.label)}</span>`;
  const selectedObject = () => selected;
  const factory = new Function("state", "escapeHtml", "dragCard", "selectedObject", `${source}\nreturn ${name};`);
  return factory(state, escapeHtml, dragCard, selectedObject);
}

const matchingQuestion = {
  id: "q-match",
  type: "matching",
  clips: [
    { id: "clip-a", label: "Clip A" },
    { id: "clip-b", label: "Clip B" }
  ],
  options: [
    { id: "opt-a", label: "Option A" },
    { id: "opt-b", label: "Option B" }
  ],
  correctPairs: { "clip-a": "opt-a", "clip-b": "opt-b" }
};

test("matchingBoard never emits an uninterpolated template placeholder", () => {
  for (const phase of ["open", "locked", "reveal"]) {
    const render = boardRenderer("matchingBoard", { state: { phase, revealedCorrectPairs: matchingQuestion.correctPairs } });
    const presenterHtml = render(matchingQuestion, false, true);
    assert.doesNotMatch(presenterHtml, /\$\{/, `presentation matching board leaked a raw \${...} in phase ${phase}`);
  }
});

test("matchingBoard's empty clip pool tells the audience what to do", () => {
  // Presentation always takes the empty-pool branch: the populated branch is
  // guarded by `!presenter`.
  const open = boardRenderer("matchingBoard", { state: { phase: "open", revealedCorrectPairs: {} } })(matchingQuestion, false, true);
  assert.match(open, /<span class="drag-empty">Listen for each clip<\/span>/);

  const reveal = boardRenderer("matchingBoard", { state: { phase: "reveal", revealedCorrectPairs: matchingQuestion.correctPairs } })(matchingQuestion, false, true);
  assert.match(reveal, /<span class="drag-empty">All items placed<\/span>/);
});

test("a player who has assigned every clip sees the empty-pool message, not source text", () => {
  const selected = { "clip-a": "opt-a", "clip-b": "opt-b" };
  const render = boardRenderer("matchingBoard", { state: { phase: "open" }, selected });
  const html = render(matchingQuestion, true, false);
  assert.doesNotMatch(html, /\$\{/);
  assert.match(html, /All items placed/);
});
