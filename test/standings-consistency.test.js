import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rankPlayers, resolvePresenterCredit } from "../quiz-core.js";

// Every surface that prints a finishing position must print the same one.
// Six sites ranked players independently and three of them numbered rows
// positionally, so tied players got different positions depending on where you
// looked -- the exported CSV could contradict the final standings the shared
// screen had just announced (review 2026-08-17, C9).
//
// app.js cannot be imported under node, so the surfaces are lifted out of its
// source and rendered against stubs.
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

// Ada and Bela tie for the lead; Cleo and Dev tie behind them.
const ROSTER = [
  { id: "c", name: "Cleo", points: 8 },
  { id: "a", name: "Ada", points: 10 },
  { id: "b", name: "Bela", points: 10 },
  { id: "d", name: "Dev", points: 8 },
  { id: "e", name: "Eze", points: 1 }
];
const EXPECTED = { Ada: 1, Bela: 1, Cleo: 3, Dev: 3, Eze: 5 };

function surfaces() {
  return liftFunctions(["resultsCsv", "csvCell", "leaderboard", "leaderboardRows", "playerScoreCards", "presentationLeaderboard"], {
    state: { players: ROSTER, phase: "complete" },
    playerId: "a",
    rankPlayers,
    escapeHtml: (value) => String(value ?? ""),
    playerLogoMarkup: () => ""
  });
}

// Each surface prints the rank in a different element; pull name/rank pairs out
// of the markup rather than trusting a shared helper.
// csvCell quotes every field, so unwrap before comparing.
function ranksFromCsv(csv) {
  return Object.fromEntries(csv.trim().split("\n").slice(1).map((line) => {
    const cells = line.split(",").map((cell) => cell.replace(/^"|"$/g, "").replace(/""/g, '"'));
    return [cells[1], Number(cells[0])];
  }));
}

function ranksFromHtml(html, pattern) {
  return Object.fromEntries([...html.matchAll(pattern)].map((match) => [match[2], Number(match[1])]));
}

test("the standings CSV shares rank between tied players", () => {
  assert.deepEqual(ranksFromCsv(surfaces().resultsCsv(ROSTER)), EXPECTED);
});

test("the host leaderboard panel shares rank between tied players", () => {
  const html = surfaces().leaderboard();
  assert.deepEqual(ranksFromHtml(html, /class="place">(\d+)<\/span><span><b>([^<]+)<\/b>/g), EXPECTED);
});

test("the player mini-leaderboard shares rank between tied players", () => {
  const html = surfaces().playerScoreCards(ROSTER, 10);
  assert.deepEqual(ranksFromHtml(html, /class="player-mini-place">(\d+)<\/span><strong>([^<]+)<\/strong>/g), EXPECTED);
});

test("only one player is described as holding the lead per tied pair", () => {
  // Both leaders are tied, so neither may be singled out as the sole leader by
  // position alone.
  const html = surfaces().leaderboard();
  const leaders = [...html.matchAll(/<b>([^<]+)<\/b><br\/><small>Holding the lead<\/small>/g)].map((match) => match[1]);
  assert.deepEqual(leaders.sort(), ["Ada", "Bela"]);
});

test("every surface agrees with every other on a tied roster", () => {
  const lifted = surfaces();
  const csv = ranksFromCsv(lifted.resultsCsv(ROSTER));
  const host = ranksFromHtml(lifted.leaderboard(), /class="place">(\d+)<\/span><span><b>([^<]+)<\/b>/g);
  const phone = ranksFromHtml(lifted.playerScoreCards(ROSTER, 10), /class="player-mini-place">(\d+)<\/span><strong>([^<]+)<\/strong>/g);
  assert.deepEqual(csv, host, "the exported standings disagree with the host panel");
  assert.deepEqual(csv, phone, "the exported standings disagree with the player's phone");
});

test("the Presentation final-scores pages share rank between tied players", () => {
  const lifted = liftFunctions(["finalScoreTitlePage", "rankedPlayers"], {
    state: { players: ROSTER, phase: "complete", presentationScreen: "final_scores" },
    hostQuizDefinition: { title: "Quiz night", titlePage: {} },
    FINAL_SCORE_PAGE_SIZE: 10,
    rankPlayers,
    resolvePresenterCredit,
    escapeHtml: (value) => String(value ?? ""),
    playerLogoMarkup: () => ""
  });
  const html = lifted.finalScoreTitlePage();
  assert.deepEqual(ranksFromHtml(html, /<span>(\d+)<\/span><strong>([^<]+)<\/strong>/g), EXPECTED);
});
