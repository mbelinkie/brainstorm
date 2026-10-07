import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMigratedDb } from "./helpers/migrated-db.js";
import { HOST_SECRET, battleFixtures } from "./helpers/battle-fixtures.js";

// Ordinary authored IDs are free text, so one can equal the resolver's readable
// battle-r<round>-m<matchup> CSV label. That label is not event identity.
const QUESTION_ID = "battle-r2-m1";
const db = await createMigratedDb();
const { makeMatchup, resolve } = battleFixtures(db);

async function scoreRows(fixture) {
  return (await db.query(
    `select player_id, question_id, points::float8 as points, base_points::float8 as base_points,
            multiplier::float8 as multiplier, reason, created_by
     from public.score_events where session_id = $1 order by reason, player_id`,
    [fixture.session]
  )).rows;
}

async function configureOrdinaryQuestion(fixture) {
  const row = (await db.query("select definition from public.quiz_versions where id = $1", [fixture.version])).rows[0];
  const definition = typeof row.definition === "string" ? JSON.parse(row.definition) : row.definition;
  definition.rounds[0] = {
    id: "ordinary-round", title: "Ordinary", questions: [{
      id: QUESTION_ID, type: "single_choice", prompt: "Pick one", points: 5,
      options: [{ id: "right", label: "Right" }, { id: "wrong", label: "Wrong" }],
      correctOptionIds: ["right"],
    }],
  };
  await db.query("update public.quiz_versions set definition = $2::jsonb where id = $1", [fixture.version, JSON.stringify(definition)]);
  await db.query(
    "update public.sessions set current_round_index = 0, phase = 'question_open', state = jsonb_build_object('phase', 'question_open', 'questionId', $2::text) where id = $1",
    [fixture.session, QUESTION_ID]
  );
  for (const playerId of [fixture.entries[0].playerId, fixture.voterIds[0]]) {
    await db.query(
      "insert into public.submissions (session_id, question_id, player_id, answer, server_revision) values ($1, $2, $3, $4::jsonb, 1)",
      [fixture.session, QUESTION_ID, playerId, JSON.stringify("right")]
    );
  }
}

test("an ordinary system score with a resolver-shaped ID can coexist when battle resolves later", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1, roundIndex: 1 });
  await fixture.vote(0, 0);
  await db.query(
    "insert into public.score_events (session_id, player_id, question_id, points, reason, created_by, base_points, multiplier) values ($1, $2, $3, 5, 'Ordinary scoring', 'system', 5, 1)",
    [fixture.session, fixture.entries[0].playerId, QUESTION_ID]
  );

  const result = await resolve(fixture);

  assert.equal(result.outcome, "winner");
  assert.equal(result.created, true);
  const rows = await scoreRows(fixture);
  assert.deepEqual(rows.map(({ player_id, points, reason, base_points, multiplier }) => ({ player_id, points, reason, base_points, multiplier })), [
    { player_id: fixture.entries[0].playerId, points: 100, reason: "Prompt battle win · 1 of 1 votes", base_points: null, multiplier: null },
    { player_id: fixture.voterIds[0], points: 10, reason: "Prompt battle vote", base_points: null, multiplier: null },
    { player_id: fixture.entries[0].playerId, points: 5, reason: "Ordinary scoring", base_points: 5, multiplier: 1 },
  ].sort((a, b) => `${a.reason}|${a.player_id}`.localeCompare(`${b.reason}|${b.player_id}`)));
  const identity = (await db.query(
    "select reason, battle_matchup_id::text as battle_matchup_id from public.score_events where session_id = $1 order by reason",
    [fixture.session]
  )).rows;
  assert.deepEqual(identity, [
    { reason: "Ordinary scoring", battle_matchup_id: null },
    { reason: "Prompt battle vote", battle_matchup_id: fixture.matchup },
    { reason: "Prompt battle win · 1 of 1 votes", battle_matchup_id: fixture.matchup },
  ]);
});

test("ordinary rescoring replaces only ordinary events and preserves battle identity and awards", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1, roundIndex: 1 });
  await fixture.vote(0, 0);
  const battleResult = await resolve(fixture);
  const originalBattleEvents = (await scoreRows(fixture)).filter((event) => event.reason.startsWith("Prompt battle"));
  assert.equal(originalBattleEvents.length, 2);

  await configureOrdinaryQuestion(fixture);
  const ordinaryScore = (await db.query(
    "select public.lock_and_score_live_question($1, $2) as result",
    [fixture.roomCode, HOST_SECRET]
  )).rows[0].result;
  assert.equal(ordinaryScore.replacedEvents, 0);
  let rows = await scoreRows(fixture);
  assert.deepEqual(rows.filter((event) => event.reason.startsWith("Prompt battle")), originalBattleEvents);
  assert.equal(rows.filter((event) => event.reason === "Automatic scoring").length, 2);

  await db.query(
    "update public.sessions set phase = 'question_open', state = jsonb_build_object('phase', 'question_open', 'questionId', $2::text) where id = $1",
    [fixture.session, QUESTION_ID]
  );
  const ordinaryReplay = (await db.query(
    "select public.lock_and_score_live_question($1, $2) as result",
    [fixture.roomCode, HOST_SECRET]
  )).rows[0].result;
  assert.equal(ordinaryReplay.replacedEvents, 2);
  rows = await scoreRows(fixture);
  assert.deepEqual(rows.filter((event) => event.reason.startsWith("Prompt battle")), originalBattleEvents);
  assert.equal(rows.filter((event) => event.reason === "Automatic scoring").length, 2);

  const identity = (await db.query(
    "select reason, battle_matchup_id::text as battle_matchup_id from public.score_events where session_id = $1 order by reason",
    [fixture.session]
  )).rows;
  for (const event of identity) {
    assert.equal(event.battle_matchup_id, event.reason.startsWith("Prompt battle") ? fixture.matchup : null);
  }

  await db.query("update public.sessions set current_round_index = 1 where id = $1", [fixture.session]);
  const resolverReplay = await resolve(fixture);
  assert.equal(resolverReplay.created, false);
  assert.equal(resolverReplay.outcome, battleResult.outcome);
  assert.equal(resolverReplay.entries.find((entry) => entry.winner).points, 100);
  assert.deepEqual((await scoreRows(fixture)).filter((event) => event.reason.startsWith("Prompt battle")), originalBattleEvents);
});


test("migration backfills only historical battle events and preserves resolved awards on replay", async () => {
  const legacyDb = await createMigratedDb({ upTo: "0043_prompt_battle_media_purge.sql" });
  const legacyFixtures = battleFixtures(legacyDb);
  const fixture = await legacyFixtures.makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1 });
  await fixture.vote(0, 0);
  const firstResult = await legacyFixtures.resolve(fixture);
  assert.equal(firstResult.created, true);
  assert.equal(firstResult.outcome, "winner");

  // An ordinary question may carry the same readable ID. It has a different
  // scorer reason and did not create either historical battle event.
  await legacyDb.query(
    "insert into public.score_events (session_id, player_id, question_id, points, reason, created_by, base_points, multiplier) values ($1, $2, $3, 5, 'Automatic scoring', 'system', 5, 1)",
    [fixture.session, fixture.entries[1].playerId, QUESTION_ID]
  );
  const legacyEvents = async () => (await legacyDb.query(
    `select id::text as id, session_id::text as session_id, player_id::text as player_id, question_id,
            points::text as points, reason, created_by, created_at::text as created_at
     from public.score_events where session_id = $1 order by reason, player_id`,
    [fixture.session]
  )).rows;
  const beforeEvents = await legacyEvents();
  assert.equal(beforeEvents.length, 3);

  const migration = readFileSync(new URL("../supabase/migrations/0044_battle_score_event_identity.sql", import.meta.url), "utf8");
  await legacyDb.exec(migration);

  const afterEvents = await legacyEvents();
  assert.deepEqual(afterEvents, beforeEvents, "backfill changes identity metadata only, not historical awards");
  const identities = (await legacyDb.query(
    "select reason, battle_matchup_id::text as battle_matchup_id from public.score_events where session_id = $1 order by reason, player_id",
    [fixture.session]
  )).rows;
  assert.deepEqual(identities, [
    { reason: "Automatic scoring", battle_matchup_id: null },
    { reason: "Prompt battle vote", battle_matchup_id: fixture.matchup },
    { reason: "Prompt battle win · 1 of 1 votes", battle_matchup_id: fixture.matchup },
  ]);

  const replay = await legacyFixtures.resolve(fixture);
  assert.equal(replay.created, false);
  assert.equal(replay.resolvedAt, firstResult.resolvedAt);
  assert.deepEqual(await legacyEvents(), beforeEvents, "a resolved replay does not re-award or rewrite migrated events");
});
