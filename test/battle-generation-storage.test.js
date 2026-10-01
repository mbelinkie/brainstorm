// Slice 16.4 — offline source-presence regression for 0037 storage/access/shuffle.
// These tests do not execute SQL. They assert the migration source still contains
// the completed storage, authorization, and shuffle behavior. The existing
// test/battle-pairing.test.js remains the real arithmetic fixture; this file
// deliberately does not duplicate it or invent fake fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationsDir = new URL('../supabase/migrations/', import.meta.url);
const raw37 = fs.readFileSync(new URL('0037_prompt_battle_generations.sql', migrationsDir), 'utf8');
const raw29 = fs.readFileSync(new URL('0029_presentation_only_media.sql', migrationsDir), 'utf8');

const newline = String.fromCharCode(10);

function normalizedSql(input) {
  return input
    .split(newline)
    .map((line) => {
      const comment = line.indexOf('--');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const sql = normalizedSql(raw37);
const sql29 = normalizedSql(raw29);

function functionBody(name, sourceRaw) {
  const start = sourceRaw.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} not defined`);
  const end = sourceRaw.indexOf(`${newline}$$;`, start);
  assert.notEqual(end, -1, `${name} opens but never closes with '$$;'`);
  return normalizedSql(sourceRaw.slice(start, end));
}

function assertContains(haystack, needle, message = `${needle}`) {
  assert.ok(haystack.includes(needle), message);
}

function assertNotContains(haystack, needle, message = `${needle}`) {
  assert.ok(!haystack.includes(needle), message);
}

test('migration presence: session_battle_generations has every column, default, FK cascade, unique, and status', () => {
  assertContains(sql, `create table if not exists public.session_battle_generations (`);
  assertContains(sql, `id uuid primary key default gen_random_uuid(),`);
  assertContains(sql, `entry_id uuid not null references public.session_battle_entries(id) on delete cascade,`);
  assertContains(sql, `attempt_index integer not null,`);
  assertContains(sql, `player_prompt text not null,`);
  assertContains(sql, `provider text not null,`);
  assertContains(sql, `model text not null,`);
  assertContains(sql, `asset_ids uuid[] not null default '{}',`);
  assertContains(sql, `status text not null default 'pending' check (status in ('pending', 'complete', 'failed', 'blocked')),`);
  assertContains(sql, `block_reason text,`);
  assertContains(sql, `cost_usd numeric(8,4),`);
  assertContains(sql, `created_at timestamptz not null default now(),`);
  assertContains(sql, `unique (entry_id, attempt_index)`);
});

test('migration presence: session_battle_generations RLS is on with explicit service_role select and no browser role', () => {
  assertContains(sql, `alter table public.session_battle_generations enable row level security;`);
  assertContains(sql, `grant select on table public.session_battle_generations to service_role;`);
  const forbiddenTableGrant = /\bgrant\s+(?:(?:select|insert|update|delete|all)(?:\s*,\s*(?:select|insert|update|delete|all))*|all)\s+on\s+(?:table\s+)?public\.session_battle_generations\s+to\s+(?:[^;]*\b(?:anon|authenticated|public)\b)/i;
  assert.ok(!forbiddenTableGrant.test(sql), `browser/public grants to session_battle_generations must be absent`);
  assertNotContains(sql, `grant insert on table public.session_battle_generations`);
  assertNotContains(sql, `grant update on table public.session_battle_generations`);
  assertNotContains(sql, `grant delete on table public.session_battle_generations`);
  assertNotContains(sql, `grant all on table public.session_battle_generations`);
  assertNotContains(sql, `create policy`);
});

test('migration presence: media_assets gets nullable uploaded_by, source default/check, player FK SET NULL, nullable expiry, and exact owner check', () => {
  assertContains(sql, `alter table public.media_assets alter column uploaded_by drop not null;`);
  assertContains(sql, `alter table public.media_assets add column if not exists source text not null default 'author' check (source in ('author', 'battle'));`);
  assertContains(sql, `alter table public.media_assets add column if not exists generated_by_player_id uuid references public.session_players(id) on delete set null;`);
  assertContains(sql, `alter table public.media_assets add column if not exists expires_at timestamptz;`);
  assertContains(sql, `alter table public.media_assets add constraint media_assets_owner_present check (source = 'battle' or uploaded_by is not null);`);
  assertNotContains(sql, `expires_at timestamptz not null`);
});

test('migration presence: quiz-media bucket retains webp/jpeg/png plus audio/video and is not narrowed by this migration', () => {
  const migration32Files = fs.readdirSync(migrationsDir).filter((f) => f.startsWith('0032') && f.endsWith('.sql'));
  assert.equal(migration32Files.length, 1, `expected exactly one 0032 migration, saw ${migration32Files.length}`);
  const raw32 = fs.readFileSync(new URL(migration32Files[0], migrationsDir), 'utf8');
  const sql32 = normalizedSql(raw32);
  assertContains(sql32, `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)`);
  assertContains(sql32, `false, 26214400`);
  for (const mime of [`'audio/mpeg'`, `'audio/mp4'`, `'audio/aac'`, `'audio/ogg'`, `'audio/wav'`, `'audio/x-wav'`, `'image/jpeg'`, `'image/png'`, `'image/webp'`, `'video/mp4'`]) {
    assertContains(sql32, mime);
  }
  assertNotContains(sql, `storage.buckets`);
  assertNotContains(sql, `allowed_mime_types`);
  assertNotContains(sql, `file_size_limit`);
});

test('migration presence: retained author comment names battle rows and actual object-byte access', () => {
  assertContains(raw37, `Quiz authors can read media records`);
  assertContains(raw37, `battle-sourced rows`);
  assertContains(raw37, `storage.objects`);
  assertContains(raw37, `/author-media`);
  assertContains(raw37, `image/object bytes`);
});

test('migration presence: can_access_live_media fails closed on missing session, asset, or player', () => {
  const body = functionBody('can_access_live_media', raw37);
  assertContains(body, `select * into active_session from public.sessions where room_code = upper(trim(p_room_code));`);
  assertContains(body, `select * into asset from public.media_assets where id = p_asset_id;`);
  assertContains(body, `select * into active_player from public.session_players p where p.session_id = active_session.id and p.player_token_hash = public.token_hash(p_player_token);`);
  const notFoundCount = body.split(`if not found then return false; end if;`).length - 1;
  assert.ok(notFoundCount >= 3, `expected at least three fail-closed not-found returns, saw ${notFoundCount}`);
  const beginIdx = body.indexOf('begin');
  assert.ok(beginIdx >= 0, 'plpgsql begin missing');
  const executable = body.slice(beginIdx);
  assertContains(executable, `return false;`);
  const lastReturnFalse = executable.lastIndexOf(`return false;`);
  assert.ok(lastReturnFalse >= 0, `terminal return false missing`);
  assert.ok(!executable.slice(lastReturnFalse + `return false;`.length).includes(`return`), `return false must be terminal before end`);
  assertNotContains(executable, `return true;`);
});

test('migration presence: can_access_live_media host battle branch stays in-session and precedes quiz fallback', () => {
  const body = functionBody('can_access_live_media', raw37);
  assertContains(body, `if p_host_secret is not null and active_session.host_secret_hash = public.token_hash(p_host_secret) then`);
  const hostBattleIdx = body.indexOf(`if asset.source = 'battle' then`);
  const hostQuizIdx = body.indexOf(`from public.quiz_versions`);
  assert.ok(hostBattleIdx >= 0, `host battle branch missing`);
  assert.ok(hostQuizIdx > hostBattleIdx, `host battle branch must return before the old quiz-reference fallback`);
  assertContains(body, `select 1 from public.session_players p where p.id = asset.generated_by_player_id and p.session_id = active_session.id`);
  assertContains(body, `return exists (select 1 from public.quiz_versions q where q.id = active_session.quiz_version_id and position(p_asset_id::text in q.definition::text) > 0);`);
});

test('migration presence: player battle branch requires own-player, own-session, generation/entry/matchup membership and precedes options fallback', () => {
  const body = functionBody('can_access_live_media', raw37);
  const firstBattle = body.indexOf(`if asset.source = 'battle' then`);
  const playerBattleIdx = body.indexOf(`if asset.source = 'battle' then`, firstBattle + 1);
  const optionsIdx = body.indexOf(`jsonb_build_object('question'`);
  assert.ok(playerBattleIdx > firstBattle, `player battle branch missing`);
  assert.ok(optionsIdx > playerBattleIdx, `player battle branch must return before the old player-options check`);

  assertContains(body, `active_session.phase::text not in ('battle_prompt', 'battle_review', 'battle_vote', 'battle_result')`);
  assertContains(body, `asset.generated_by_player_id = active_player.id and exists (select 1 from public.session_battle_generations g join public.session_battle_entries e on e.id = g.entry_id join public.session_battle_matchups m on m.id = e.matchup_id where e.player_id = active_player.id and m.session_id = active_session.id and p_asset_id = any(g.asset_ids)`);
  assertNotContains(body, `uploaded_by`);
  assertNotContains(body, `opponent`);
  assertNotContains(body, `submitted_asset_id`);
  assertNotContains(body, `current_matchup`);
  assertNotContains(body, `generated_by_player_id = active_player.id or`);
});

test('migration presence: 0029 legacy host quiz and player options predicates plus grants are preserved exactly', () => {
  assertContains(sql, `return exists (select 1 from public.quiz_versions q where q.id = active_session.quiz_version_id and position(p_asset_id::text in q.definition::text) > 0);`);
  assertContains(sql, `return active_session.state @> jsonb_build_object('question', jsonb_build_object('options', jsonb_build_array(jsonb_build_object('imageAssetId', p_asset_id::text))));`);
  assertContains(sql, `grant execute on function public.can_access_live_media(text, uuid, text, text) to anon, authenticated, service_role;`);
  assertContains(sql29, `grant execute on function public.can_access_live_media(text, uuid, text, text) to anon, authenticated, service_role;`);
});

test('migration presence: battle phases are compared as ::text only, never bare enum', () => {
  assertContains(sql, `active_session.phase::text = 'complete'`);
  assertContains(sql, `active_session.phase::text not in ('battle_prompt', 'battle_review', 'battle_vote', 'battle_result')`);
  assertNotContains(sql, `active_session.phase in (`);
  assertNotContains(sql, `active_session.phase not in (`);
  assertNotContains(sql, `active_session.phase = `);
  assertNotContains(sql, `active_session.phase <> `);
  assertNotContains(sql, `active_session.phase != `);
});

test('migration presence: open_battle_round idempotency guard still precedes quiz read, prompt shuffle, and any matchup insert', () => {
  const body = functionBody('open_battle_round', raw37);
  const guardIdx = body.indexOf(`if exists (`);
  const quizIdx = body.indexOf(`from public.quiz_versions`);
  const shuffleIdx = body.indexOf(`jsonb_agg(prompt_item order by md5`);
  const insertIdx = body.indexOf(`insert into public.session_battle_matchups`);
  assert.ok(guardIdx >= 0);
  assert.ok(quizIdx > guardIdx, `guard must precede quiz read`);
  assert.ok(shuffleIdx > guardIdx, `guard must precede prompt shuffle`);
  assert.ok(insertIdx > guardIdx, `guard must precede first matchup insert`);
});

test('migration presence: prompt ordering is a deterministic md5 aggregate over persisted seed, round, prompt id, and ordinal tie-breaker', () => {
  const body = functionBody('open_battle_round', raw37);
  assertContains(body, `select jsonb_agg(prompt_item order by md5(shuffle_seed::text || ':' || active_session.current_round_index::text || ':prompt:' || (prompt_item ->> 'id')), prompt_ordinal)`);
  assertContains(body, `from jsonb_array_elements(round_prompts) with ordinality as prompts(prompt_item, prompt_ordinal)`);
  assertContains(body, `round_prompts -> (matchup_position % prompt_count)`);
  assertNotContains(body, `order by random()`);
});

test('migration presence: shuffle seed is persisted once and reused, never overwritten on retry', () => {
  const body = functionBody('open_battle_round', raw37);
  assertContains(body, `if active_session.battle_shuffle_seed is null then`);
  assertContains(body, `shuffle_seed := floor(random() * 9007199254740992)::bigint;`);
  assertContains(body, `else shuffle_seed := active_session.battle_shuffle_seed;`);
  const firstSeedUpdate = body.indexOf(`update public.sessions set battle_shuffle_seed`);
  const secondSeedUpdate = body.indexOf(`update public.sessions set battle_shuffle_seed`, firstSeedUpdate + 1);
  assert.equal(secondSeedUpdate, -1, `seed update must appear only inside null branch`);
});

test('migration presence: player pairing arithmetic and seeded ordering are unchanged', () => {
  const body = functionBody('open_battle_round', raw37);
  assertContains(body, `matchup_count := player_count / 2;`);
  assertContains(body, `least(player_ordinal / 2, matchup_count - 1)`);
  assertContains(body, `order by md5(shuffle_seed::text || ':' || active_session.current_round_index::text || ':' || p.id::text)`);
  assertContains(body, `if player_count < 2 then raise exception 'A battle round needs at least two joined players'; end if;`);
});

test('migration presence: broadcast state still carries only round position, never prompt/pairing/player leaks', () => {
  const body = functionBody('open_battle_round', raw37);
  const stateStart = body.indexOf(`state = state || jsonb_build_object(`);
  assert.ok(stateStart >= 0);
  const stateEnd = body.indexOf(`revision = revision + 1`, stateStart);
  assert.ok(stateEnd > stateStart);
  const stateWrite = body.slice(stateStart, stateEnd);
  for (const leak of [`prompt_text`, `promptText`, `entrants`, `player_id`, `playerId`, `matchups`]) {
    assertNotContains(stateWrite, leak);
  }
  assertContains(stateWrite, `'battleRoundIndex'`);
  assertContains(stateWrite, `'battleMatchupIndex'`);
});
