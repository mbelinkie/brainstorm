// Prompt Battle slice 2 — schema foundation and round pairing.
//
// Naming note, matching test/scoring-contract.test.js: tests prefixed
// "migration presence" or "source presence" assert that a named rule still
// exists in the text they read. Nothing here executes SQL or renders a
// surface, so they are change detectors, not proofs of behavior. The migration
// has deliberately NOT been applied to any database, so a contract test over
// its text is the only coverage that exists for it today.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrationName = "0036_prompt_battle_rounds.sql";
const sql = fs.readFileSync(new URL(migrationName, migrationsDir), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const roomApi = fs.readFileSync(new URL("../room-api.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${migrationName} does not define ${name}`);
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${migrationName} opens ${name} but never closes it with "$$;"`);
  return sql.slice(start, end);
}

test("migration presence: the four battle phases are added to session_phase", () => {
  for (const phase of ["battle_prompt", "battle_review", "battle_vote", "battle_result"]) {
    assert.match(sql, new RegExp(`alter type public\\.session_phase add value if not exists '${phase}'`));
  }
});

test("migration presence: only the two tables this slice owns are created", () => {
  const created = [...sql.matchAll(/create table if not exists public\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(created.sort(), ["session_battle_entries", "session_battle_matchups"]);
  // session_battle_generations and session_battle_votes belong to slices 3 and
  // 5. Creating them early would commit to a shape nothing writes yet.
  assert.doesNotMatch(sql, /create table[^;]*session_battle_generations/);
  assert.doesNotMatch(sql, /create table[^;]*session_battle_votes/);
});

test("migration presence: media_assets is left alone in this slice", () => {
  // Base spec 8.1 drops uploaded_by's NOT NULL and adds the battle columns.
  // That belongs to slice 3, when a generated image is first persisted.
  assert.doesNotMatch(sql, /alter table public\.media_assets/);
});

test("migration presence: RLS is enabled on both new tables, with no browser-role grants", () => {
  for (const table of ["session_battle_matchups", "session_battle_entries"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    // 0025's pattern: RLS on, no policies, every access through a
    // security definer RPC. A grant to anon/authenticated would be the hole.
    assert.doesNotMatch(sql, new RegExp(`grant [a-z ,]*on table public\\.${table} to [^;]*\\b(anon|authenticated)\\b`));
  }
});

test("migration presence: every new table is granted select to service_role", () => {
  // This project has no blanket service_role SELECT (0019, 0023, 0028, 0033).
  // The Worker's slice-3 generate route reads both tables directly, and a
  // missing grant fails at request time, not at deploy time.
  const granted = new Set(
    [...sql.matchAll(/grant\s+select\s+on\s+table\s+public\.([a-z_]+)\s+to\s+([^;]+);/gi)]
      .filter((match) => /\bservice_role\b/i.test(match[2]))
      .map((match) => match[1])
  );
  const created = [...sql.matchAll(/create table if not exists public\.([a-z_]+)/g)].map((match) => match[1]);
  for (const table of created) {
    assert.ok(granted.has(table), `${migrationName} creates ${table} but never grants it select to service_role`);
  }
});

test("migration presence: phase is compared as ::text, never as a bare enum literal", () => {
  // A value added to session_phase cannot be used as a bare enum literal in
  // the same transaction that adds it (0025's precedent). Assignment in an
  // UPDATE SET is a different position and is written unqualified there, so
  // this scopes to reads of the fetched row.
  assert.match(sql, /active_session\.phase::text/);
  const bareComparisons = [...sql.matchAll(/active_session\.phase\s*(=|<>|!=|not\s+in|in)\s/gi)];
  assert.deepEqual(bareComparisons.map((match) => match[0].trim()), [], "every comparison of active_session.phase must go through ::text");
});

test("migration presence: open_battle_round guards on an existing pairing before doing anything else", () => {
  const body = functionBody("open_battle_round");
  // The idempotency clause. A host refresh must return the existing pairing,
  // never reshuffle matchups players have already started working on.
  const guard = body.indexOf("if exists (");
  assert.ok(guard > 0, "open_battle_round has no existence guard");
  assert.match(body.slice(guard, guard + 400), /from public\.session_battle_matchups/);
  assert.match(body.slice(guard, guard + 400), /round_index = active_session\.current_round_index/);
  assert.match(body.slice(guard, guard + 700), /'created', false/);

  // The guard must precede every insert, or a second call writes rows.
  const firstInsert = body.indexOf("insert into public.session_battle_matchups");
  assert.ok(firstInsert > guard, "the existence guard must come before the first matchup insert");
  // ...and precede the quiz-definition read: once a round is paired, the
  // pairing is the answer whatever the definition says now.
  assert.ok(body.indexOf("from public.quiz_versions") > guard, "the existence guard must come before the quiz-definition lookup");
});

test("migration presence: open_battle_round takes the session row for update", () => {
  // Two host tabs, or a double-click, reach this concurrently. Without the
  // row lock both can pass the existence guard and both can pair.
  const body = functionBody("open_battle_round");
  assert.match(body, /from public\.sessions[\s\S]*?for update;/);
});

test("migration presence: an odd player count makes the final matchup a three-way", () => {
  const body = functionBody("open_battle_round");
  // floor division gives one matchup per pair; the odd player out would index
  // one past the last matchup and is clamped back into it by least().
  assert.match(body, /matchup_count := player_count \/ 2;/);
  assert.match(body, /least\(player_ordinal \/ 2, matchup_count - 1\)/);
  assert.match(body, /player_count < 2/, "a battle round needs at least two players to pair");
});

test("migration presence: pairing is seeded from a value persisted on the session", () => {
  const body = functionBody("open_battle_round");
  // Reproducible and auditable: the ordering is a pure function of the stored
  // seed, the round index, and the player IDs -- not of random() at pair time.
  assert.match(sql, /alter table public\.sessions[\s\S]*?battle_shuffle_seed bigint/);
  assert.match(body, /if active_session\.battle_shuffle_seed is null then/);
  assert.match(body, /order by md5\(shuffle_seed::text \|\| ':' \|\| active_session\.current_round_index::text \|\| ':' \|\| p\.id::text\)/);
});

test("migration presence: prompts cycle when there are more matchups than prompts", () => {
  const body = functionBody("open_battle_round");
  assert.match(body, /round_prompts -> \(matchup_position % prompt_count\)/);
  assert.match(body, /prompt_count = 0/, "a battle round with no prompts must be rejected");
});

test("migration presence: the pairing never enters the broadcast room state", () => {
  const body = functionBody("open_battle_round");
  const stateWrite = body.slice(body.indexOf("state = state || jsonb_build_object("), body.indexOf("revision = revision + 1"));
  assert.ok(stateWrite.length > 0, "expected open_battle_round to write public room state");
  // sessions.state is returned verbatim to every player phone by
  // get_live_room_state(). Round position is fine; entrants, prompt texts and
  // matchup membership are future state (product invariant: players never
  // receive future state).
  for (const leak of ["prompt_text", "promptText", "entrants", "player_id", "playerId", "matchups"]) {
    assert.ok(!stateWrite.includes(leak), `open_battle_round puts "${leak}" into broadcast room state`);
  }
  assert.match(stateWrite, /'battleRoundIndex'/);
  assert.match(stateWrite, /'battleMatchupIndex'/);
});

test("migration presence: the shuffle seed and effective engine are columns, not broadcast state", () => {
  assert.match(sql, /alter table public\.sessions[\s\S]*?battle_engine_provider text/);
  assert.match(sql, /alter table public\.sessions[\s\S]*?battle_engine_model text/);
  const engineBody = functionBody("set_battle_engine");
  assert.doesNotMatch(engineBody, /state = state/, "the effective engine must not be written into broadcast room state");
});

test("migration presence: set_battle_engine validates the model against permittedModels", () => {
  const body = functionBody("set_battle_engine");
  assert.match(body, /permittedModels/);
  assert.match(body, /@> to_jsonb\(safe_model\)/);
  // A model only some battle rounds permit is the wrong engine for the others:
  // there is one effective engine per session.
  assert.match(body, /permitting_round_count < battle_round_count/);
  assert.match(body, /raise exception 'That model is not permitted by this quiz'/);
});

test("migration presence: all three RPCs authorize on the host secret", () => {
  for (const name of ["open_battle_round", "set_battle_engine", "get_host_battle_state"]) {
    const body = functionBody(name);
    assert.match(body, /security definer/, `${name} must be security definer`);
    assert.match(body, /host_secret_hash = public\.token_hash\(p_host_secret\)/, `${name} must check the host secret`);
    assert.match(body, /raise exception 'Host authorization failed'/, `${name} must reject an unauthorized caller`);
  }
});

test("migration presence: the shared payload helper is not reachable from a browser role", () => {
  // Invoker rights and no authorization check of its own, so execute is
  // revoked from public; only the definer functions above it can call it.
  assert.match(sql, /create or replace function public\.host_battle_state_payload/);
  assert.match(sql, /revoke all on function public\.host_battle_state_payload\(uuid, integer\) from public;/);
  assert.doesNotMatch(sql, /grant execute on function public\.host_battle_state_payload/);
});

test("source presence: room-api exposes the three host RPCs and no player battle call", () => {
  for (const [wrapper, rpc] of [["openBattleRound", "open_battle_round"], ["setBattleEngine", "set_battle_engine"], ["getHostBattleState", "get_host_battle_state"]]) {
    assert.match(roomApi, new RegExp(`${wrapper}\\(\\{ roomCode, hostSecret`), `${wrapper} must take a host secret`);
    assert.match(roomApi, new RegExp(`call\\("${rpc}"`));
  }
  // No player-token battle wrapper exists yet: submission and voting are
  // slices 3 and 5.
  assert.doesNotMatch(roomApi, /playerToken[^)]*battle|battle[A-Za-z]*\(\{ roomCode, playerToken/i);
});

test("source presence: the pairing panel is host-only and never touches broadcast state", () => {
  const definitions = app.match(/function battlePairingPanel\(/g) || [];
  assert.equal(definitions.length, 1, "battlePairingPanel should be defined exactly once");
  // Slice 3a renders the panel only in renderHostBattle, the host screen for
  // the whole battle round (its start card and battle_prompt).
  const callSites = app.match(/\$\{battlePairingPanel\(\)\}/g) || [];
  assert.equal(callSites.length, 1, "battlePairingPanel() should be called from renderHostBattle only");

  // Same guarantee test/battle-test-panel.test.js pins for the slice-1 panel:
  // the pairing maps player names to matchups and must never be assigned onto
  // `state`, where publicRoomState() could forward it to a phone.
  // state.battleRoundIndex (slice 3a) is a public round position, not the
  // pairing. What must never reach state is the panel or its matchups.
  assert.doesNotMatch(app, /state\.battleRoundPanel|state\.battleRound\s*=|state\.(matchups|pairing)\b|state\.battle(Pairing|Matchups|Entrants)|\.\.\.battleRoundPanel|Object\.assign\(state/);
  assert.match(app, /let battleRoundPanel = /, "expected battleRoundPanel to be its own module-level variable, not a field on `state`");

  const renderPlayer = app.slice(app.indexOf("function renderPlayer("), app.indexOf("\nfunction ", app.indexOf("function renderPlayer(") + 1));
  const renderPresenter = app.slice(app.indexOf("function renderPresenter("), app.indexOf("\nfunction ", app.indexOf("function renderPresenter(") + 1));
  for (const [name, body] of [["renderPlayer", renderPlayer], ["renderPresenter", renderPresenter]]) {
    assert.doesNotMatch(body, /battlePairingPanel|data-battle-open-round|data-battle-refresh-pairing/, `${name} must not render the host-only pairing panel`);
  }
});

// The distribution the pairing arithmetic produces. Unlike the source-text
// checks above, this one computes: it mirrors open_battle_round()'s two lines
// (matchup_count := player_count / 2, then
//  target_matchup := least(player_ordinal / 2, matchup_count - 1)) and asserts
// the shape they yield. The mirror is guarded against drift by the
// "an odd player count makes the final matchup a three-way" test above, which
// fails if either line changes in the migration.
//
// These expectations are a recorded result, not a prediction: on 2026-08-25 the
// same two expressions were evaluated in the deployed Postgres over
// generate_series for player counts 2..9 and produced exactly this table.
function pairingSizes(playerCount) {
  const matchupCount = Math.floor(playerCount / 2);
  const sizes = new Array(matchupCount).fill(0);
  for (let ordinal = 0; ordinal < playerCount; ordinal += 1) {
    sizes[Math.min(Math.floor(ordinal / 2), matchupCount - 1)] += 1;
  }
  return sizes;
}

test("pairing places every player, and only the final matchup is ever a three-way", () => {
  const expected = {
    2: [2],
    3: [3],
    4: [2, 2],
    5: [2, 3],
    6: [2, 2, 2],
    7: [2, 2, 3],
    8: [2, 2, 2, 2],
    9: [2, 2, 2, 3],
    // The design's stated room size is 10-20 people (base spec section 1).
    20: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    21: [2, 2, 2, 2, 2, 2, 2, 2, 2, 3]
  };
  for (const [playerCount, sizes] of Object.entries(expected)) {
    const actual = pairingSizes(Number(playerCount));
    assert.deepEqual(actual, sizes, `${playerCount} players should pair as ${sizes.join(",")}`);
    // Nobody is dropped: a player left out of a matchup cannot generate, and
    // would sit through the whole round with nothing to do.
    assert.equal(actual.reduce((sum, size) => sum + size, 0), Number(playerCount), `${playerCount} players: not every player was placed`);
    // A four-way is not a shape any later slice renders: battle_vote shows two
    // or three images.
    assert.ok(Math.max(...actual) <= 3, `${playerCount} players produced a matchup larger than three`);
    // The three-way is the LAST matchup, which is what lets the host say
    // "this one's a three-way" at the end rather than mid-round.
    assert.ok(actual.indexOf(3) === -1 || actual.indexOf(3) === actual.length - 1, `${playerCount} players put the three-way somewhere other than last`);
  }
});
