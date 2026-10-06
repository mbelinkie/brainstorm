import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMigratedDb } from "./helpers/migrated-db.js";
import { HOST_SECRET, battleFixtures } from "./helpers/battle-fixtures.js";

// Issue #30: resolve_battle_matchup (migration 0042), executed for real.
// Every migration is applied to an in-process Postgres (test/helpers/
// migrated-db.js) and the RPC is called exactly as the host browser calls it.
// Fixtures are inserted directly as the database owner; only the resolver
// under test goes through its public signature.

const db = await createMigratedDb();
const { makeMatchup, resolve } = battleFixtures(db);

async function scoreEvents(fixture) {
  const { rows } = await db.query(
    `select e.player_id, e.question_id, e.points::float8 as points, e.base_points, e.multiplier, e.reason, e.created_by
     from public.score_events e where e.session_id = $1 order by e.reason, e.player_id`,
    [fixture.session]
  );
  return rows;
}

async function sessionRow(fixture) {
  const { rows } = await db.query("select phase::text as phase, revision::int as revision, state from public.sessions where id = $1", [fixture.session]);
  return rows[0];
}

function pointsByPlayer(events) {
  const totals = {};
  for (const event of events) totals[event.player_id] = (totals[event.player_id] ?? 0) + event.points;
  return totals;
}

test("the entry with the most votes wins winnerPoints and every voter earns voterPoints", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 3 });
  await fixture.vote(0, 0);
  await fixture.vote(1, 0);
  await fixture.vote(2, 1);
  const before = await sessionRow(fixture);

  const result = await resolve(fixture);

  assert.equal(result.outcome, "winner");
  assert.equal(result.created, true);
  assert.equal(result.votesCast, 3);
  const [ada, bo] = fixture.entries;
  const byEntry = Object.fromEntries(result.entries.map((entry) => [entry.entryId, entry]));
  assert.deepEqual([byEntry[ada.entryId].votes, byEntry[ada.entryId].winner, byEntry[ada.entryId].points], [2, true, 100]);
  assert.deepEqual([byEntry[bo.entryId].votes, byEntry[bo.entryId].winner, byEntry[bo.entryId].points], [1, false, 0]);

  const totals = pointsByPlayer(await scoreEvents(fixture));
  assert.deepEqual(totals, {
    [ada.playerId]: 100,
    [fixture.voterIds[0]]: 10,
    [fixture.voterIds[1]]: 10,
    [fixture.voterIds[2]]: 10,
  });

  const after = await sessionRow(fixture);
  assert.equal(after.phase, "battle_result");
  assert.equal(after.state.phase, "battle_result");
  assert.equal(after.revision, before.revision + 1);
  assert.ok(result.resolvedAt);
});

test("every tied entrant receives the full winnerPoints", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }, { name: "Cy" }], voters: 3 });
  await fixture.vote(0, 0);
  await fixture.vote(1, 1);
  await fixture.vote(2, 2);

  const result = await resolve(fixture);

  assert.equal(result.outcome, "tie");
  const totals = pointsByPlayer(await scoreEvents(fixture));
  for (const entry of fixture.entries) assert.equal(totals[entry.playerId], 100, entry.name);
  for (const voterId of fixture.voterIds) assert.equal(totals[voterId], 10);
});

test("a matchup nobody could vote on is a tie between all viable entries", async () => {
  // Two-player rooms have no eligible voters at all: both players are entrants.
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }] });

  const result = await resolve(fixture);

  assert.equal(result.outcome, "tie");
  assert.equal(result.votesCast, 0);
  const totals = pointsByPlayer(await scoreEvents(fixture));
  assert.deepEqual(totals, { [fixture.entries[0].playerId]: 100, [fixture.entries[1].playerId]: 100 });
});

test("a vetoed entry cannot win even with the most votes, and its voters still earn voterPoints", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada", vetoed: true }, { name: "Bo" }, { name: "Cy" }], voters: 4 });
  await fixture.vote(0, 0);
  await fixture.vote(1, 0);
  await fixture.vote(2, 0);
  await fixture.vote(3, 1);

  const result = await resolve(fixture);

  assert.equal(result.outcome, "winner");
  const [ada, bo, cy] = fixture.entries;
  const totals = pointsByPlayer(await scoreEvents(fixture));
  assert.equal(totals[ada.playerId], undefined);
  assert.equal(totals[bo.playerId], 100);
  assert.equal(totals[cy.playerId], undefined);
  for (const voterId of fixture.voterIds) assert.equal(totals[voterId], 10);
  const adaResult = result.entries.find((entry) => entry.entryId === ada.entryId);
  assert.deepEqual([adaResult.viable, adaResult.vetoed, adaResult.winner, adaResult.votes], [false, true, false, 3]);
});

test("a lone viable entrant wins by default against a forfeit", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo", submitted: false, forfeited: true }], voters: 1 });
  await fixture.vote(0, 0);

  const result = await resolve(fixture);

  assert.equal(result.outcome, "default");
  const totals = pointsByPlayer(await scoreEvents(fixture));
  assert.deepEqual(totals, { [fixture.entries[0].playerId]: 100, [fixture.voterIds[0]]: 10 });
});

test("a lone viable entrant wins by default even when nobody voted for it", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada", vetoed: true }, { name: "Bo" }], voters: 1 });
  await fixture.vote(0, 0);

  const result = await resolve(fixture);

  assert.equal(result.outcome, "default");
  const totals = pointsByPlayer(await scoreEvents(fixture));
  assert.equal(totals[fixture.entries[1].playerId], 100);
  assert.equal(totals[fixture.voterIds[0]], 10);
});

test("an all-vetoed or all-forfeited matchup is skipped: no points for anyone, still resolved", async () => {
  const fixture = await makeMatchup({
    entrants: [{ name: "Ada", vetoed: true }, { name: "Bo", submitted: false, forfeited: true }],
    voters: 2,
  });
  await fixture.vote(0, 0);

  const result = await resolve(fixture);

  assert.equal(result.outcome, "skipped");
  assert.deepEqual(await scoreEvents(fixture), []);
  assert.ok(result.resolvedAt);
  assert.equal((await sessionRow(fixture)).phase, "battle_result");
});

test("resolving twice scores once and replays the same result without writing", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 2 });
  await fixture.vote(0, 0);
  await fixture.vote(1, 0);

  const first = await resolve(fixture);
  const eventsAfterFirst = await scoreEvents(fixture);
  const sessionAfterFirst = await sessionRow(fixture);

  // A later veto (host walked phase back) must not change a resolved result.
  await db.query("update public.session_battle_entries set vetoed_at = now(), veto_reason = 'late' where id = $1", [fixture.entries[0].entryId]);
  const second = await resolve(fixture);

  assert.equal(second.created, false);
  const strip = ({ created, revision, phase, ...rest }) => rest;
  assert.deepEqual(strip(second), strip(first));
  assert.deepEqual(await scoreEvents(fixture), eventsAfterFirst);
  assert.deepEqual(await sessionRow(fixture), sessionAfterFirst);
});

test("no second scoring path: a duplicate battle score event is rejected by the database", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1 });
  await fixture.vote(0, 0);
  await resolve(fixture);
  const [winnerEvent] = (await scoreEvents(fixture)).filter((event) => event.player_id === fixture.entries[0].playerId);

  await assert.rejects(
    db.query(
      "insert into public.score_events (session_id, player_id, question_id, points, reason, created_by) values ($1, $2, $3, 100, 'again', 'system')",
      [fixture.session, winnerEvent.player_id, winnerEvent.question_id]
    ),
    /duplicate key/
  );
});

test("door rewards and catch-up boosts do not multiply battle points", async () => {
  // Doors target round 1 or later, so the battle is the second round here.
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1, roundIndex: 1 });
  const [ada] = fixture.entries;
  await db.query(
    "insert into public.session_door_choices (session_id, player_id, target_round_index, door_id, resolved_multiplier) values ($1, $2, 1, 'd1', 3)",
    [fixture.session, ada.playerId]
  );
  await db.query("update public.session_players set late_join_multiplier = 2, late_join_target_round_index = 1 where id = $1", [fixture.voterIds[0]]);
  await fixture.vote(0, 0);

  await resolve(fixture);

  const totals = pointsByPlayer(await scoreEvents(fixture));
  assert.deepEqual(totals, { [ada.playerId]: 100, [fixture.voterIds[0]]: 10 });
});

test("score events explain themselves in the host CSV export", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }, { name: "Cy" }], voters: 2, roundIndex: 1, matchupIndex: 2 });
  await fixture.vote(0, 0);
  await fixture.vote(1, 1);
  await resolve(fixture);

  const { rows } = await db.query("select public.get_host_score_events($1, $2) as events", [fixture.roomCode, HOST_SECRET]);
  const events = rows[0].events;
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(event.questionId, "battle-r2-m3");
    assert.match(event.reason, /^Prompt battle /);
  }
  const reasons = events.map((event) => `${event.displayName}: ${event.reason}`).sort();
  assert.deepEqual(reasons, [
    "Ada: Prompt battle tie (2 ways) · 1 of 2 votes",
    "Bo: Prompt battle tie (2 ways) · 1 of 2 votes",
    "Voter 1: Prompt battle vote",
    "Voter 2: Prompt battle vote",
  ]);
});

test("creators are revealed in the resolution result", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1 });
  await fixture.vote(0, 1);

  const result = await resolve(fixture);

  const names = result.entries.map((entry) => entry.playerName);
  assert.deepEqual(names, ["Bo", "Ada"], "ordered by votes, then name");
  assert.ok(result.entries.every((entry) => entry.assetId));
  // Nothing about the result is pushed into sessions.state, which every
  // player phone receives verbatim; the host relays it.
  const { state } = await sessionRow(fixture);
  assert.deepEqual(Object.keys(state).sort(), ["battleMatchupIndex", "battleRoundIndex", "phase"]);
});

test("refusals leave rows, revision and state untouched", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1, matchupIndex: 0, pointer: 0 });
  await fixture.vote(0, 0);
  const before = await sessionRow(fixture);

  await assert.rejects(resolve(fixture, { hostSecret: "wrong" }), /Host authorization failed/);
  await assert.rejects(resolve(fixture, { matchupId: null }), /matchup must be selected/);
  await assert.rejects(resolve(fixture, { matchupId: randomUUID() }), /not the current matchup/);

  await db.query("update public.sessions set state = state || '{\"battleMatchupIndex\": 1}' where id = $1", [fixture.session]);
  await assert.rejects(resolve(fixture), /not the current matchup/);
  await db.query("update public.sessions set state = state || '{\"battleMatchupIndex\": 0}', phase = 'battle_review' where id = $1", [fixture.session]);
  await assert.rejects(resolve(fixture), /not in the battle_vote phase/);
  await db.query("update public.sessions set phase = 'battle_vote' where id = $1", [fixture.session]);

  assert.deepEqual(await scoreEvents(fixture), []);
  const { rows } = await db.query("select resolved_at, result from public.session_battle_matchups where id = $1", [fixture.matchup]);
  assert.deepEqual(rows[0], { resolved_at: null, result: null });
  assert.equal((await sessionRow(fixture)).revision, before.revision);
});

test("a resolved matchup refuses further votes", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1 });
  await resolve(fixture);
  await db.query("update public.sessions set phase = 'battle_vote' where id = $1", [fixture.session]);

  await assert.rejects(
    db.query("select public.cast_battle_vote($1, $2, $3, $4)", [fixture.roomCode, `token-${fixture.voterIds[0]}`, fixture.matchup, fixture.entries[0].entryId]),
    /not the current matchup/
  );
});

test("the resolver is callable by the browser roles", async () => {
  const { rows } = await db.query(`
    select
      has_function_privilege('anon', 'public.resolve_battle_matchup(text, text, uuid)', 'execute') as anon_resolve,
      has_function_privilege('authenticated', 'public.resolve_battle_matchup(text, text, uuid)', 'execute') as auth_resolve
  `);
  assert.deepEqual(rows[0], { anon_resolve: true, auth_resolve: true });
});
