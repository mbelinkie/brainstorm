import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Behavioral tests for the closest_number results wall on Presentation.
//
// The wall ranks players, prints a ★ beside the winner and announces "Tied
// winners". Migration 0017_closest_number_scoring.sql already computed the
// winning distance, the winner count and the split points from every
// submission, so the wall must never re-derive any of that from a partial list
// (review 2026-08-17, C7 / APP F6).
//
// app.js is a browser module with top-level DOM side effects and cannot be
// imported under node, so the functions under test are lifted out of its source
// and evaluated against stand-ins for app.js's module-level bindings.
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function liftFunctions(names, scope = {}) {
  const sources = names.map((name) => {
    const start = app.indexOf(`\nfunction ${name}(`);
    assert.notEqual(start, -1, `${name} not found in app.js — did it get renamed?`);
    const end = app.indexOf("\n}\n", start);
    assert.notEqual(end, -1, `could not find the end of ${name} in app.js`);
    return app.slice(start + 1, end + 3);
  }).join("\n");
  const keys = Object.keys(scope);
  const factory = new Function(...keys, `${sources}\nreturn { ${names.join(", ")} };`);
  return factory(...keys.map((key) => scope[key]));
}

function closestNumberBoard({ guesses = [], guessesQuestionId = "", realtime = [], realtimeQuestionId = "", error = false, questionId = "q-closest", target = 100 } = {}) {
  const lifted = liftFunctions(
    ["closestNumberResultsBoard", "closestNumberResultEntries", "closestNumberDecimal", "formatClosestDecimal"],
    {
      state: { phase: "reveal", questionId, question: { id: questionId, type: "closest_number" } },
      escapeHtml: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      closestNumberGuesses: guesses,
      closestNumberGuessesQuestionId: guessesQuestionId,
      realtimeClosestNumberGuesses: new Map(realtime.map((entry) => [entry.playerName, entry])),
      realtimeClosestNumberGuessesQuestionId: realtimeQuestionId,
      closestNumberGuessesError: error,
      closestNumberTarget: () => target,
      playerLogoMarkup: () => "",
      validNumericGuess: (value) => /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(String(value).trim())
    }
  );
  return lifted.closestNumberResultsBoard();
}

// The server scored Ada closest.
const FULL_GUESSES = [
  { playerName: "Ada", logoKey: null, guess: "101" },
  { playerName: "Bela", logoKey: null, guess: "90" },
  { playerName: "Cleo", logoKey: null, guess: "70" }
];
// What a Presentation tab opened mid-question happens to hold: it missed Ada's
// broadcast entirely.
const PARTIAL_REALTIME = [
  { playerName: "Bela", logoKey: null, guess: "90" },
  { playerName: "Cleo", logoKey: null, guess: "70" }
];

test("the closest-number wall ranks the server's full guess list", () => {
  const html = closestNumberBoard({ guesses: FULL_GUESSES, guessesQuestionId: "q-closest" });
  assert.match(html, /★/);
  assert.match(html, /Ada/);
});

test("the closest-number wall never crowns a winner from the realtime subset", () => {
  // The authoritative fetch failed, so closestNumberGuessesQuestionId never
  // advanced to this question.
  const html = closestNumberBoard({ guessesQuestionId: "", realtime: PARTIAL_REALTIME, realtimeQuestionId: "q-closest", error: true });
  assert.doesNotMatch(html, /★/, "shared screen crowned a winner from a partial guess list");
  assert.doesNotMatch(html, /closest-match-row/, "shared screen rendered a ranked board from a partial guess list");
  assert.doesNotMatch(html, /Bela/, "shared screen ranked players the server did not score against");
});

test("a failed guess fetch says so instead of showing an empty board", () => {
  const html = closestNumberBoard({ guessesQuestionId: "", realtime: PARTIAL_REALTIME, realtimeQuestionId: "q-closest", error: true });
  assert.match(html, /could not be loaded/i);
});

test("a guess fetch still in flight is not reported as nobody guessing", () => {
  const html = closestNumberBoard({ guessesQuestionId: "", realtime: PARTIAL_REALTIME, realtimeQuestionId: "q-closest", error: false });
  assert.doesNotMatch(html, /No valid guesses were submitted/, "pending load rendered as an authoritative empty result");
});

test("an authoritative empty result still reads as nobody guessing", () => {
  const html = closestNumberBoard({ guesses: [], guessesQuestionId: "q-closest" });
  assert.match(html, /No valid guesses were submitted/);
});
