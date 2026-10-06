// Prompt Battle veto and host review projection RPCs (issue #25, migration 0040).
// Static contract tests for the migration text. Each test first asserts that
// exactly one 0040 migration exists, then checks a specific public contract.
// These are change detectors, not runtime proofs; runtime behavior is
// exercised by test/sql/battle-review-runtime.py.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
let migrationFiles = [];
let migrationName = "";
let raw = "";
let sql = "";

function loadMigration() {
  migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.startsWith("0040_") && name.endsWith(".sql"));
  migrationName = migrationFiles[0] || "0040_(missing).sql";
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
  assert.equal(migrationFiles.length, 1, `expected exactly one 0040 migration, saw ${migrationFiles.length}`);
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

function assertRegex(haystack, regex, message = `expected to match: ${regex}`) {
  assert.ok(regex.test(haystack), message);
}

function assertBefore(haystack, first, second, message) {
  const firstIdx = haystack.indexOf(first);
  const secondIdx = haystack.indexOf(second);
  assert.ok(firstIdx >= 0, `missing: ${first}`);
  assert.ok(secondIdx >= 0, `missing: ${second}`);
  assert.ok(firstIdx < secondIdx, message || `${first} must come before ${second}`);
}

test("migration presence: exactly one 0040 migration exists and only defines the new veto RPC plus the helper replacement", () => {
  assertMigrationPresent();
  const defined = [...raw.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((match) => match[1]).sort();
  assert.deepEqual(defined, ["host_battle_state_payload", "veto_battle_entry"]);
  assert.doesNotMatch(sql, /create table/i);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /create type/i);
  assert.doesNotMatch(sql, /alter table/i);
});

test("migration presence: veto_battle_entry is security definer with search_path public; helper stays SQL stable invoker", () => {
  assertMigrationPresent();
  const vetoBody = functionBody("veto_battle_entry");
  assertContains(vetoBody, "language plpgsql security definer set search_path = public as $$", "veto_battle_entry must be security definer with search_path = public");
  const helperBody = functionBody("host_battle_state_payload");
  assertContains(helperBody, "language sql stable set search_path = public");
  assertNotContains(helperBody, "language plpgsql security definer");
});

test("migration presence: veto_battle_entry has the required arguments and default boolean", () => {
  assertMigrationPresent();
  const rawStart = raw.indexOf("create or replace function public.veto_battle_entry(");
  assert.ok(rawStart >= 0, "missing veto_battle_entry");
  const rawEnd = raw.indexOf("returns jsonb", rawStart);
  assert.ok(rawEnd > rawStart, "missing returns jsonb");
  const signature = raw.slice(rawStart, rawEnd);
  assertContains(signature, "p_room_code text");
  assertContains(signature, "p_host_secret text");
  assertContains(signature, "p_entry_id uuid");
  assertContains(signature, "p_reason text");
  assertContains(signature, "p_veto boolean default true");
});

test("contract: veto_battle_entry locks session before entry, requires battle_review, validates reason, updates revision and updated_at on meaningful change, and clears fields on undo", () => {
  assertMigrationPresent();
  const body = functionBody("veto_battle_entry");
  const sessionLockIdx = body.search(/select\s+[^;]*?from\s+public\.sessions[^;]*?for\s+update/i);
  const entryLockIdx = body.search(/select\s+[^;]*?from\s+public\.session_battle_entries[^;]*?for\s+update/i);
  assert.ok(sessionLockIdx >= 0, "veto must lock sessions row");
  assert.ok(entryLockIdx >= 0, "veto must lock entry row");
  assert.ok(sessionLockIdx < entryLockIdx, "veto must lock session before entry");
  assertContains(body, "public.token_hash(p_host_secret)");
  assertContains(body, "raise exception");
  assertContains(body, "trim(");
  assertContains(body, "char_length");
  assertContains(body, "500");
  assertContains(body, "phase::text = 'battle_review'");
  assertContains(body, "update public.session_battle_entries set vetoed_at = now(), veto_reason = ");
  assertContains(body, "update public.session_battle_entries set vetoed_at = null, veto_reason = null");
  assertContains(body, "revision = revision + 1");
  assertContains(body, "updated_at = now()");
});

test("contract: host_battle_state_payload includes new entrant and matchup fields with derived viability and skipped logic", () => {
  assertMigrationPresent();
  const body = functionBody("host_battle_state_payload");
  for (const key of ["vetoedAt", "vetoReason", "viable", "generations"]) {
    assertContains(body, `'${key}',`, `helper must include ${key}`);
  }
  assertContains(body, "attemptIndex");
  assertContains(body, "status");
  assertContains(body, "playerPrompt");
  assertContains(body, "assetIds");
  assertContains(body, "viableEntryIds");
  assertContains(body, "skipped");
  // Relaxed viability condition; allow alias prefixes and any AND ordering.
  assertRegex(body, /submitted_asset_id\s+is\s+not\s+null/i, "viability requires submitted_asset_id is not null");
  assertRegex(body, /forfeited_at\s+is\s+null/i, "viability requires forfeited_at is null");
  assertRegex(body, /vetoed_at\s+is\s+null/i, "viability requires vetoed_at is null");
  assertRegex(body, /not\s+exists/i, "skipped logic requires not exists");
  assertContains(body, "forfeited_at is null");
  assertNotContains(body, "update public.session_battle_matchups set resolved_at");
  assertNotContains(body, "skipped boolean");
});

test("migration presence: grants/revokes for veto_battle_entry and helper", () => {
  assertMigrationPresent();
  const signature = "public.veto_battle_entry(text, text, uuid, text, boolean)";
  assertContains(sql, `revoke all on function ${signature} from public;`);
  assertContains(sql, `grant execute on function ${signature} to anon, authenticated;`);
  assertBefore(sql, `revoke all on function ${signature}`, `grant execute on function ${signature}`);
  assertContains(sql, "revoke all on function public.host_battle_state_payload(uuid, integer) from public, anon, authenticated, service_role;");
  const helperGrant = /grant [^;]*on function public\.host_battle_state_payload/;
  assert.doesNotMatch(sql, helperGrant, "helper must not be granted to any role");
});

test("migration presence: no direct table grants/policies and no voting/scoring/media access changes", () => {
  assertMigrationPresent();
  assert.doesNotMatch(sql, /grant [^;]*on table public\.session_battle_entries/);
  assert.doesNotMatch(sql, /grant [^;]*on table public\.session_battle_matchups/);
  assert.doesNotMatch(sql, /create policy/i);
  assert.doesNotMatch(sql, /session_battle_votes/);
  assert.doesNotMatch(sql, /score_events/);
  assert.doesNotMatch(sql, /insert into public\.session_battle_votes/);
  assert.doesNotMatch(sql, /insert into public\.score_events/);
  assert.doesNotMatch(sql, /create or replace function public\.(submit|lock|authorize|record|refund)/);
});

test("privacy/scope: veto and helper do not expose host secrets or session state internals", () => {
  assertMigrationPresent();
  const vetoBody = functionBody("veto_battle_entry");
  const helperBody = functionBody("host_battle_state_payload");
  assertNotContains(vetoBody, "sessions.state");
  assertNotContains(helperBody, "host_secret_hash");
  assertNotContains(helperBody, "token_hash");
  assertNotContains(helperBody, "'secret'");
  assertNotContains(helperBody, "private");
});
