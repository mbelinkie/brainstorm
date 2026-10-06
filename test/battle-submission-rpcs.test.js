// Prompt Battle submission and host lock RPCs (issue #24, migration 0039).
//
// Static contract tests for the migration text.  Each test first asserts that
// exactly one 0039 migration exists, then checks a specific public contract.
// These are change detectors, not runtime proofs; the runtime behavior is
// exercised by test/sql/battle-submission-runtime.py.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
let migrationFiles = [];
let migrationName = "";
let raw = "";
let sql = "";

function loadMigration() {
  migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.startsWith("0039_") && name.endsWith(".sql"));
  migrationName = migrationFiles[0] || "0039_(missing).sql";
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
  assert.equal(migrationFiles.length, 1, `expected exactly one 0039 migration, saw ${migrationFiles.length}`);
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

test("migration presence: exactly one 0039 migration exists and only defines the two new RPCs plus the helper replacement", () => {
  assertMigrationPresent();
  const defined = [...raw.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((match) => match[1]).sort();
  assert.deepEqual(defined, ["host_battle_state_payload", "lock_battle_prompt", "submit_battle_entry"]);
  assert.doesNotMatch(sql, /create table/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /create type/i);
});

test("migration presence: adds nullable forfeited_at timestamptz to session_battle_entries", () => {
  assertMigrationPresent();
  assertContains(sql, "alter table public.session_battle_entries add column if not exists forfeited_at timestamptz;");
  assert.doesNotMatch(sql, /forfeited_at timestamptz not null/);
  assert.doesNotMatch(sql, /forfeited_at timestamptz default/);
});

test("migration presence: submit_battle_entry and lock_battle_prompt are security definer with search_path public", () => {
  assertMigrationPresent();
  for (const name of ["submit_battle_entry", "lock_battle_prompt"]) {
    const body = functionBody(name);
    assertContains(body, "language plpgsql security definer set search_path = public as $$", `${name} must be security definer with search_path = public`);
  }
});

test("migration presence: host_battle_state_payload stays SQL stable invoker", () => {
  assertMigrationPresent();
  const body = functionBody("host_battle_state_payload");
  assertContains(body, "language sql stable set search_path = public");
  assertNotContains(body, "language plpgsql security definer");
});

test("migration presence: submit_battle_entry and lock_battle_prompt are revoked from public then granted only to anon and authenticated", () => {
  assertMigrationPresent();
  for (const [name, args] of Object.entries({
    submit_battle_entry: "text, text, uuid",
    lock_battle_prompt: "text, text",
  })) {
    const signature = `public.${name}(${args})`;
    assertContains(sql, `revoke all on function ${signature} from public;`);
    assertContains(sql, `grant execute on function ${signature} to anon, authenticated;`);
    assertBefore(sql, `revoke all on function ${signature}`, `grant execute on function ${signature}`);
    const browserGrant = new RegExp(`grant [^;]*on function public\\.${name}\\b[^;]*\\b(service_role|public)\\b`, "i");
    assert.doesNotMatch(sql, browserGrant, `${name} must not be granted to service_role or public`);
  }
});

test("migration presence: helper execute is revoked from public, anon, authenticated and service_role", () => {
  assertMigrationPresent();
  assertContains(sql, "revoke all on function public.host_battle_state_payload(uuid, integer) from public, anon, authenticated, service_role;");
  const helperGrant = /grant [^;]*on function public\.host_battle_state_payload/;
  assert.doesNotMatch(sql, helperGrant, "helper must not be granted to any role");
});

test("contract: submit_battle_entry locks session before entry, rejects wrong phase/no entry, validates own complete asset", () => {
  assertMigrationPresent();
  const body = functionBody("submit_battle_entry");
  // Session-row lock must precede entry-row lock. Aliases can vary.
  const sessionLockIdx = body.search(/select\s+[^;]*?from\s+public\.sessions[^;]*?for\s+update/i);
  const entryLockIdx = body.search(/select\s+[^;]*?from\s+public\.session_battle_entries[^;]*?for\s+update/i);
  assert.ok(sessionLockIdx >= 0, "submit must lock sessions row");
  assert.ok(entryLockIdx >= 0, "submit must lock entry row");
  assert.ok(sessionLockIdx < entryLockIdx, "submit must lock session before entry");
  assertContains(body, "public.token_hash(p_player_token)");
  assert.ok(/\.phase::text\s*<>\s*'battle_prompt'/.test(body), "submit must reject wrong phase");
  assertContains(body, "raise exception");
  assertContains(body, "public.session_battle_entries");
  assertContains(body, "public.session_battle_matchups");
  assertContains(body, "a.source = 'battle'");
  assertContains(body, "g.status = 'complete'");
  assertContains(body, "and m.session_id =");
  assertContains(body, "and g.entry_id =");
  assertContains(body, "update public.session_battle_entries set submitted_asset_id = p_asset_id, submitted_at = now(), forfeited_at = null");
});

test("contract: submit returns only entryId, submittedAssetId and submittedAt", () => {
  assertMigrationPresent();
  const body = functionBody("submit_battle_entry");
  const submitReturn = body.slice(body.indexOf("return jsonb_build_object("));
  assert.ok(submitReturn.includes("'entryId'") && submitReturn.includes("'submittedAssetId'") && submitReturn.includes("'submittedAt'"));
  // Ensure no explicit room/phase/roster/spend keys in the returned object.
  for (const forbidden of ["roomCode", "phase", "roster", "spend", "maxSessionSpendUsd", "promptText"]) {
    assert.ok(!submitReturn.includes(`'${forbidden}'`), `submit return leaks ${forbidden}`);
  }
});

test("contract: host lock first checks phase, refuses non battle_prompt and replays battle_review", () => {
  assertMigrationPresent();
  const body = functionBody("lock_battle_prompt");
  assert.ok(/if\s+[a-z_]+\.phase::text\s*=\s*'battle_review'\s+then/.test(body), "must replay battle_review");
  assert.ok(/return\s+public\.host_battle_state_payload\([^)]*\)\s*\|\|\s*jsonb_build_object\([^)]*'locked'\s*,\s*false\s*\)/.test(body), "must return locked:false on replay");
  assert.ok(/if\s+[a-z_]+\.phase::text\s*<>\s*'battle_prompt'\s+then\s+raise exception/.test(body), "must refuse non battle_prompt");
});

test("contract: auto-select uses latest complete generation and forfeits image-less entries", () => {
  assertMigrationPresent();
  const body = functionBody("lock_battle_prompt");
  assert.ok(/order\s+by\s+[a-z_]+\.attempt_index\s+desc/.test(body), "must order by attempt_index desc");
  assert.ok(/[a-z_]+\.status\s*=\s*'complete'/.test(body), "must filter complete generations");
  assertContains(body, "forfeited_at = now()");
  assertContains(body, "submitted_asset_id = null");
});

test("contract: helper adds roster, spend and cap fields without leaking them", () => {
  assertMigrationPresent();
  const body = functionBody("host_battle_state_payload");
  for (const key of ["submittedAssetId", "submittedAt", "forfeited", "forfeitedAt", "sessionSpendUsd", "maxSessionSpendUsd"]) {
    assertContains(body, `'${key}',`, `helper must include ${key}`);
  }
  assertContains(body, "coalesce(sum(");
  assertContains(body, "cost_usd");
  assertContains(body, "maxSessionSpendUsd");
  assertNotContains(body, "update public.sessions");
});

test("migration presence: no new direct table grants/policies and no new voting/scoring/veto writes", () => {
  assertMigrationPresent();
  assert.doesNotMatch(sql, /grant [^;]*on table public\.session_battle_entries/);
  assert.doesNotMatch(sql, /create policy/);

  // Out-of-scope for this migration: new functions or tables for voting,
  // scoring, or veto management.  Existing veto columns read by the helper are
  // allowed; this migration must not write to them or create new vote/score
  // objects.
  for (const outOfScope of [
    "session_battle_votes",
    "battle_vote",
    "battle_result",
    "create or replace function public.*vote",
    "create or replace function public.*score",
    "create or replace function public.*veto",
    "insert into public.session_battle_votes",
    "insert into public.score_events",
    "update public.session_battle_entries set vetoed_at",
    "update public.session_battle_entries set veto_reason",
  ]) {
    assertNotContains(sql, outOfScope, `${outOfScope} belongs to a later slice`);
  }
});
