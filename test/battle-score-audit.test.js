import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { rankPlayers } from "../quiz-core.js";
import { createMigratedDb } from "./helpers/migrated-db.js";
import { HOST_SECRET, battleFixtures } from "./helpers/battle-fixtures.js";

// Issue #34: battle points must explain themselves wherever scores are read.
// A matchup is resolved for real (0042, in PGlite), then the rows flow through
// the same reads the host uses: get_host_score_events into the detailed CSV,
// and get_live_leaderboard into the standings CSV.

const db = await createMigratedDb();
const { makeMatchup, resolve } = battleFixtures(db);

// room-api.js reads window.QUIZ_PLATFORM_CONFIG at module load. PGlite treats
// a global `window` as a browser, so the stub exists only for that import,
// after the database is up.
const hadWindow = "window" in globalThis;
globalThis.window = globalThis.window || {};
const { resolveBattleMatchupWithStandings } = await import("../room-api.js");
if (!hadWindow) delete globalThis.window;

// app.js cannot be imported under node; lift the export builders out of it
// the way test/standings-consistency.test.js does.
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
function liftFunctions(names, scope = {}) {
  const sources = names.map((name) => {
    const start = app.indexOf(`\nfunction ${name}(`);
    assert.notEqual(start, -1, `${name} not found in app.js`);
    return app.slice(start + 1, app.indexOf("\n}\n", start) + 3);
  }).join("\n");
  const keys = Object.keys(scope);
  return new Function(...keys, `${sources}\nreturn { ${names.join(", ")} };`)(...keys.map((key) => scope[key]));
}
const { scoreEventsCsv, resultsCsv } = liftFunctions(["scoreEventsCsv", "resultsCsv", "csvCell"], { rankPlayers });

function parseCsv(text) {
  return text.trim().split("\n").map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"')));
}

async function hostScoreEvents(fixture) {
  const { rows } = await db.query("select public.get_host_score_events($1, $2) as events", [fixture.roomCode, HOST_SECRET]);
  return rows[0].events;
}

async function leaderboard(fixture) {
  const { rows } = await db.query("select public.get_live_leaderboard($1, $2) as players", [fixture.roomCode, HOST_SECRET]);
  return rows[0].players;
}

const withoutTime = (rows) => rows.map((row) => row.slice(0, 6)).sort((a, b) => a.join("|").localeCompare(b.join("|")));

test("the detailed CSV explains every battle event, next to an ordinary trivia event", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 2, roundIndex: 1, matchupIndex: 0 });
  await db.query(
    "insert into public.score_events (session_id, player_id, question_id, points, reason, created_by, base_points, multiplier) values ($1, $2, 'q-trivia', 5, 'Automatic scoring', 'system', 5, 1)",
    [fixture.session, fixture.voterIds[0]]
  );
  await fixture.vote(0, 0);
  await fixture.vote(1, 1);
  await resolve(fixture);

  const [header, ...rows] = parseCsv(scoreEventsCsv(await hostScoreEvents(fixture)));

  assert.deepEqual(header, ["Display name", "Question ID", "Base points", "Multiplier", "Points", "Reason", "Recorded at"]);
  assert.deepEqual(withoutTime(rows), [
    ["Ada", "battle-r2-m1", "", "", "100", "Prompt battle tie (2 ways) · 1 of 2 votes"],
    ["Bo", "battle-r2-m1", "", "", "100", "Prompt battle tie (2 ways) · 1 of 2 votes"],
    ["Voter 1", "battle-r2-m1", "", "", "10", "Prompt battle vote"],
    ["Voter 1", "q-trivia", "5", "1", "5", "Automatic scoring"],
    ["Voter 2", "battle-r2-m1", "", "", "10", "Prompt battle vote"],
  ]);
  for (const row of rows) assert.match(row[6], /^\d{4}-\d{2}-\d{2}T/, "every row carries its recorded time");
});

test("a default win and a skipped matchup read correctly in the CSV", async () => {
  const lone = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo", submitted: false, forfeited: true }], voters: 1 });
  await lone.vote(0, 0);
  await resolve(lone);
  assert.deepEqual(withoutTime(parseCsv(scoreEventsCsv(await hostScoreEvents(lone))).slice(1)), [
    ["Ada", "battle-r1-m1", "", "", "100", "Prompt battle win by default"],
    ["Voter 1", "battle-r1-m1", "", "", "10", "Prompt battle vote"],
  ]);

  const skipped = await makeMatchup({ entrants: [{ name: "Ada", vetoed: true }, { name: "Bo", vetoed: true }], voters: 1 });
  await resolve(skipped);
  assert.deepEqual(parseCsv(scoreEventsCsv(await hostScoreEvents(skipped))).slice(1), [], "a skipped matchup writes no rows");
});

test("the leaderboard and standings CSV include battle points", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 2 });
  await db.query(
    "insert into public.score_events (session_id, player_id, question_id, points, reason, created_by, base_points, multiplier) values ($1, $2, 'q-trivia', 95, 'Automatic scoring', 'system', 95, 1)",
    [fixture.session, fixture.voterIds[1]]
  );
  await fixture.vote(0, 0);
  await fixture.vote(1, 0);
  await resolve(fixture);

  const players = await leaderboard(fixture);
  assert.deepEqual(players.map((player) => [player.name, Number(player.points)]), [
    ["Voter 2", 105],
    ["Ada", 100],
    ["Voter 1", 10],
    ["Bo", 0],
  ]);
  assert.deepEqual(parseCsv(resultsCsv(players)).slice(1), [
    ["1", "Voter 2", "105"],
    ["2", "Ada", "100"],
    ["3", "Voter 1", "10"],
    ["4", "Bo", "0"],
  ]);
});

test("resolving through room-api refreshes the standings with the battle points", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1 });
  await fixture.vote(0, 1);
  const client = {
    resolveBattleMatchup: async ({ roomCode, hostSecret, matchupId }) =>
      (await db.query("select public.resolve_battle_matchup($1, $2, $3) as r", [roomCode, hostSecret, matchupId])).rows[0].r,
    getLeaderboard: async ({ roomCode, accessToken }) =>
      (await db.query("select public.get_live_leaderboard($1, $2) as p", [roomCode, accessToken])).rows[0].p,
  };

  const outcome = await resolveBattleMatchupWithStandings({ roomCode: fixture.roomCode, hostSecret: HOST_SECRET, matchupId: fixture.matchup, client });

  assert.equal(outcome.result.outcome, "winner");
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.players.map((player) => [player.name, Number(player.points)]), [["Bo", 100], ["Voter 1", 10], ["Ada", 0]]);
});

test("a failed standings read never hides a good resolution; a failed resolution reads nothing", async () => {
  const resolved = { outcome: "tie", created: true };
  const readFails = {
    resolveBattleMatchup: async () => resolved,
    getLeaderboard: async () => { throw new Error("network"); },
  };
  const outcome = await resolveBattleMatchupWithStandings({ roomCode: "ABCDEF", hostSecret: "s", matchupId: "m", client: readFails });
  assert.deepEqual([outcome.result, outcome.players, outcome.error?.message], [resolved, null, "network"]);

  let leaderboardCalls = 0;
  const resolveFails = {
    resolveBattleMatchup: async () => { throw new Error("Host authorization failed"); },
    getLeaderboard: async () => { leaderboardCalls += 1; return []; },
  };
  await assert.rejects(resolveBattleMatchupWithStandings({ roomCode: "ABCDEF", hostSecret: "bad", matchupId: "m", client: resolveFails }), /Host authorization failed/);
  assert.equal(leaderboardCalls, 0);
});

test("room-api calls the resolver with the host secret and the matchup", () => {
  const roomApiSource = fs.readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
  assert.match(roomApiSource, /resolveBattleMatchup\(\{ roomCode, hostSecret, matchupId \}\) \{\s*return call\("resolve_battle_matchup", \{ p_room_code: roomCode, p_host_secret: hostSecret, p_matchup_id: matchupId \}\);/);
});
