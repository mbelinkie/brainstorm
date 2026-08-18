import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { revealedAnswerKeys, revealKeyFor } from "../quiz-core.js";

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
  const factory = new Function("state", "escapeHtml", "dragCard", "selectedObject", "revealKeyFor", "orderedItems", `${source}\nreturn ${name};`);
  return factory(state, escapeHtml, dragCard, selectedObject, revealKeyFor, orderedItems);
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

// --- arrange_in_order (C6) ---------------------------------------------------

// orderedItems is a sibling helper orderBoard calls; lift it the same way.
const orderedItems = (() => {
  const start = app.indexOf("\nfunction orderedItems(");
  const end = app.indexOf("\n}\n", start);
  return new Function(`${app.slice(start + 1, end + 3)}\nreturn orderedItems;`)();
})();

const orderQuestion = {
  id: "q-order",
  type: "arrange_in_order",
  items: [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Bravo" },
    { id: "c", label: "Charlie" }
  ],
  correctOrder: ["c", "a", "b"]
};
// What a player phone and Presentation actually receive (quiz-core's
// toPlayerQuestion copies items but never correctOrder).
const playerSafeOrderQuestion = { id: orderQuestion.id, type: orderQuestion.type, items: orderQuestion.items };

function renderedItemIds(html) {
  return [...html.matchAll(/data-item-id="([^"]+)"/g)].map((match) => match[1]);
}

test("Presentation announces the published correct order at the reveal", () => {
  const state = { phase: "reveal", ...revealedAnswerKeys(orderQuestion, "reveal") };
  const html = boardRenderer("orderBoard", { state })(playerSafeOrderQuestion, false, true);
  assert.deepEqual(renderedItemIds(html), ["c", "a", "b"], "shared screen did not show the authoritative correct order");
  assert.match(html, /Correct order/);
});

test("Presentation does not label anything the correct order before the reveal", () => {
  for (const phase of ["open", "locked"]) {
    const state = { phase, ...revealedAnswerKeys(orderQuestion, phase) };
    const html = boardRenderer("orderBoard", { state })(playerSafeOrderQuestion, false, true);
    assert.doesNotMatch(html, /Correct order/, `shared screen claimed a correct order in phase ${phase}`);
  }
});

test("a player phone shows the published correct order at the reveal, not its own submission", () => {
  const submitted = { a: 1, b: 2, c: 3 };
  const state = { phase: "reveal", ...revealedAnswerKeys(orderQuestion, "reveal") };
  const html = boardRenderer("orderBoard", { state, selected: submitted })(playerSafeOrderQuestion, true, false);
  assert.deepEqual(renderedItemIds(html), ["c", "a", "b"], "phone announced the player's own order as correct");
  assert.match(html, /Correct order/);
});

test("a player phone keeps its own working order while answering, unlabelled", () => {
  const submitted = { b: 1, c: 2, a: 3 };
  const state = { phase: "open", ...revealedAnswerKeys(orderQuestion, "open") };
  const html = boardRenderer("orderBoard", { state, selected: submitted })(playerSafeOrderQuestion, true, false);
  assert.deepEqual(renderedItemIds(html), ["b", "c", "a"]);
  assert.doesNotMatch(html, /Correct order/);
});

test("a locked player is not told their own order is the correct one", () => {
  const submitted = { b: 1, c: 2, a: 3 };
  const state = { phase: "locked", ...revealedAnswerKeys(orderQuestion, "locked") };
  const html = boardRenderer("orderBoard", { state, selected: submitted })(playerSafeOrderQuestion, true, false);
  assert.doesNotMatch(html, /Correct order/, "phone labelled the player's own submission the correct order");
});

test("the host board still shows the authored correct order", () => {
  const state = { phase: "open" };
  const html = boardRenderer("orderBoard", { state })(orderQuestion, false, false);
  assert.deepEqual(renderedItemIds(html), ["c", "a", "b"]);
  assert.match(html, /Correct order/);
});
