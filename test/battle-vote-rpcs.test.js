// Prompt Battle vote cast RPC and host/media helpers (issue #29, migration 0041).
// Static contract tests for the migration text. Each test first asserts that
// exactly one 0041 migration exists, then checks a specific public contract.
// These are change detectors, not runtime proofs; runtime behavior is
// exercised by test/sql/battle-vote-runtime.py.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
let migrationFiles = [];
let migrationName = "";
let raw = "";
let sql = "";

function loadMigration() {
  migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.startsWith("0041_") && name.endsWith(".sql"));
  migrationName = migrationFiles[0] || "0041_(missing).sql";
  raw = migrationFiles.length === 1 ? fs.readFileSync(new URL(migrationName, migrationsDir), "utf8") : "";
  sql = normalizedSql(raw);
}

const newline = String.fromCharCode(10);

function normalizedSql(input) {
  return input
    .split(newline)
    .map((line) => {
      const comment = line.indexOf("--");
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertMigrationPresent() {
  loadMigration();
  assert.equal(migrationFiles.length, 1, `expected exactly one 0041 migration, saw ${migrationFiles.length}`);
}

function functionBody(name) {
  const start = raw.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${migrationName} does not define ${name}`);
  const end = raw.indexOf(`${newline}$$;`, start);
  assert.notEqual(end, -1, `${migrationName} opens ${name} but never closes it with '$$;'`);
  return normalizedSql(raw.slice(start, end));
}

function assertContains(haystack, needle, message = `expected to find: ${needle}`) {
  assert.ok(haystack.includes(needle), message);
}

function assertNotContains(haystack, needle, message = `expected NOT to find: ${needle}`) {
  assert.ok(!haystack.includes(needle), message);
}

function assertBefore(haystack, first, second, message) {
  const firstIdx = haystack.indexOf(first);
  const secondIdx = haystack.indexOf(second);
  assert.ok(firstIdx >= 0, `missing: ${first}`);
  assert.ok(secondIdx >= 0, `missing: ${second}`);
  assert.ok(firstIdx < secondIdx, message || `${first} must come before ${second}`);
}

test("migration presence: exactly one 0041 migration exists and defines only the vote RPC plus two replacements", () => {
  assertMigrationPresent();
  const defined = [...raw.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((match) => match[1]).sort();
  assert.deepEqual(defined, ["can_access_live_media", "cast_battle_vote", "host_battle_state_payload"]);
  // The migration must create the votes table and RLS; these are no longer forbidden.
});

test("auth/signature: cast_battle_vote is security definer with search_path public and exact signature", () => {
  assertMigrationPresent();
  const rawStart = raw.indexOf("create or replace function public.cast_battle_vote(");
  assert.ok(rawStart >= 0, "missing cast_battle_vote");
  const rawEnd = raw.indexOf("returns jsonb", rawStart);
  assert.ok(rawEnd > rawStart, "missing returns jsonb");
  const signature = raw.slice(rawStart, rawEnd);
  assertContains(signature, "p_room_code text");
  assertContains(signature, "p_player_token text");
  assertContains(signature, "p_matchup_id uuid");
  assertContains(signature, "p_entry_id uuid");
  const body = functionBody("cast_battle_vote");
  assertContains(body, "language plpgsql security definer set search_path = public");
});

test("grants/lock: cast_battle_vote granted to anon/auth only; table revoked all with service_role SELECT; can_access granted", () => {
  assertMigrationPresent();
  const voteSig = "public.cast_battle_vote(text, text, uuid, uuid)";
  assertContains(sql, `revoke all on function ${voteSig} from public;`);
  assertContains(sql, `grant execute on function ${voteSig} to anon, authenticated;`);
  assertBefore(sql, `revoke all on function ${voteSig}`, `grant execute on function ${voteSig}`);
  assertContains(sql, "revoke all on table public.session_battle_votes from public, anon, authenticated, service_role;");
  assertContains(sql, "grant select on table public.session_battle_votes to service_role;");
  assertNotContains(sql, "grant insert on table public.session_battle_votes");
  assertNotContains(sql, "grant update on table public.session_battle_votes");
  assertNotContains(sql, "grant delete on table public.session_battle_votes");
  assertContains(sql, "grant execute on function public.can_access_live_media(text, uuid, text, text) to anon, authenticated, service_role;");
});

test("schema/RLS: votes table has RLS enabled, no policies, unique constraint, FKs, and gen_random_uuid", () => {
  assertMigrationPresent();
  assertContains(sql, "alter table public.session_battle_votes enable row level security;");
  assertNotContains(sql, "create policy");
  assertContains(sql, "unique (matchup_id, voter_player_id)");
  assertContains(sql, "gen_random_uuid()");
  assertContains(sql, "references public.session_battle_matchups(id) on delete cascade");
  assertContains(sql, "references public.session_players(id) on delete cascade");
  assertContains(sql, "references public.session_battle_entries(id) on delete cascade");
  assertNotContains(sql, "create or replace function public.vote");
  assertNotContains(sql, "create or replace function public.upsert");
  assertNotContains(sql, "create or replace function public.update");
  assertNotContains(sql, "create or replace function public.delete");
});

test("current pointer validation: cast locks session before entry, validates current pointer, rejects entrants, increments revision only", () => {
  assertMigrationPresent();
  const body = functionBody("cast_battle_vote");
  const sessionLockIdx = body.search(/select\s+[^;]*?from\s+public\.sessions[^;]*?for\s+update/i);
  const entryLockIdx = body.search(/select\s+[^;]*?from\s+public\.session_battle_entries[^;]*?for\s+update/i);
  assert.ok(sessionLockIdx >= 0, "cast must lock sessions row");
  assert.ok(entryLockIdx >= 0, "cast must lock entry row");
  assert.ok(sessionLockIdx < entryLockIdx, "cast must lock session before entry");
  assertContains(body, "state -> 'battleMatchupIndex' = to_jsonb(m.matchup_index)");
  assertContains(body, "matchup_index >= 0");
  assertContains(body, "phase::text = 'battle_vote'");
  assertContains(body, "raise exception");
  assertContains(body, "revision = revision + 1");
  assertContains(body, "updated_at = now()");
  assertNotContains(body, "update public.session_battle_entries");
  assertNotContains(body, "state = state ||");
  // The migration may use an explicit unique-violation exception rather than ON CONFLICT DO NOTHING.
});

test("host fields: host helper adds votesCast and eligibleVoters per matchup while preserving existing 0040 keys", () => {
  assertMigrationPresent();
  const body = functionBody("host_battle_state_payload");
  assertContains(body, "'votesCast'");
  assertContains(body, "'eligibleVoters'");
  assertContains(body, "count(*) from public.session_battle_votes");
  assertContains(body, "left_at is null");
  assertContains(body, "not exists (select 1 from public.session_battle_entries");
  for (const key of ["viableEntryIds", "skipped", "sessionSpendUsd", "maxSessionSpendUsd", "entrants", "generations"]) {
    assertContains(body, `'${key}',`, `helper must include ${key}`);
  }
});

test("media access: vote/result phases only submitted current matchup assets, prompt/review own variants preserved", () => {
  assertMigrationPresent();
  const body = functionBody("can_access_live_media");
  assertContains(body, "phase::text in ('battle_vote', 'battle_result')");
  assertContains(body, "m.session_id = active_session.id");
  assertContains(body, "m.round_index = active_session.current_round_index");
  assertContains(body, "state -> 'battleMatchupIndex' = to_jsonb(m.matchup_index)");
  assertContains(body, "e.submitted_asset_id = p_asset_id");
  assertContains(body, "e.vetoed_at is null");
  assertContains(body, "e.forfeited_at is null");
  assertContains(body, "asset.source = 'battle'");
  assertContains(body, "generated_by_player_id = e.player_id");
  assertContains(body, "phase::text in ('battle_prompt', 'battle_review')");
  assertContains(body, "asset.generated_by_player_id = active_player.id");
  assertContains(body, "exists (select 1 from public.session_battle_generations");
});

test("privacy/scope: cast return projection has only voteId, matchupId, votedAt; no counts/creators/other choices in new paths", () => {
  assertMigrationPresent();
  const voteBody = functionBody("cast_battle_vote");
  assertContains(voteBody, "jsonb_build_object('voteId', new_vote.id, 'matchupId', p_matchup_id, 'votedAt', new_vote.created_at)");
  // Returning exactly those keys means no count/creator/target-choices in the projection.
  assertNotContains(voteBody, "jsonb_build_object('voteId', new_vote.id, 'matchupId', p_matchup_id, 'votedAt', new_vote.created_at, '");
  const helperBody = functionBody("host_battle_state_payload");
  assertNotContains(helperBody, "'voterPlayerId'");
  assertNotContains(helperBody, "'voterName'");
  assertNotContains(helperBody, "'voteChoices'");
  assertNotContains(helperBody, "'voteId'");
  assertNotContains(helperBody, "'votedAt'");
  assertNotContains(helperBody, "'targetEntryId'");
  assertNotContains(helperBody, "'targetEntryName'");
  // The host helper may contain aggregate counts and existing entrant identifiers, but not individual vote receipt/voter identity/target choice keys.
});
