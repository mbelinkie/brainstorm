// Prompt Battle generation RPCs (issue #20, migration 0038).
//
// Naming note, matching test/battle-pairing.test.js and
// test/battle-generation-storage.test.js: every test here is a "migration
// presence" / contract check. It reads the migration's TEXT and asserts that a
// named rule is still written into it. Nothing here executes SQL; the
// migration has not been applied to any database, so these are change
// detectors, not proofs of runtime behavior.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.startsWith("0038_") && name.endsWith(".sql"));
const migrationName = migrationFiles[0] || "0038_(missing).sql";
const raw = migrationFiles.length === 1 ? fs.readFileSync(new URL(migrationName, migrationsDir), "utf8") : "";

const newline = String.fromCharCode(10);

// Comments stripped and whitespace collapsed, so assertions match the rule
// rather than its line wrapping, and a rule that only survives in a comment
// does not count.
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

const sql = normalizedSql(raw);

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

const SERVICE_FUNCTIONS = {
  authorize_battle_generation: "text, text, text",
  record_battle_generation: "uuid, uuid[], numeric",
  refund_battle_attempt: "uuid, text, text"
};

test("migration presence: exactly one 0038 migration exists and it only defines the four generation RPCs", () => {
  assert.equal(migrationFiles.length, 1, `expected exactly one 0038 migration, saw ${migrationFiles.length}`);
  const defined = [...raw.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((match) => match[1]).sort();
  assert.deepEqual(defined, ["authorize_battle_generation", "get_player_battle_state", "record_battle_generation", "refund_battle_attempt"]);
  // Scope: no new tables, no schema changes, no redefinition of 0036/0037.
  assert.doesNotMatch(sql, /create table/i);
  assert.doesNotMatch(sql, /alter table/i);
  assert.doesNotMatch(sql, /alter type/i);
  assert.doesNotMatch(sql, /create policy/i);
});

test("migration presence: every new function is security definer with search_path = public", () => {
  for (const name of [...Object.keys(SERVICE_FUNCTIONS), "get_player_battle_state"]) {
    const body = functionBody(name);
    assertContains(body, "language plpgsql security definer set search_path = public as $$", `${name} must be security definer with search_path = public`);
  }
});

test("migration presence: the three Worker RPCs are revoked from public, anon and authenticated and granted to service_role only", () => {
  for (const [name, args] of Object.entries(SERVICE_FUNCTIONS)) {
    const signature = `public.${name}(${args})`;
    assertContains(sql, `revoke all on function ${signature} from public, anon, authenticated;`);
    assertContains(sql, `grant execute on function ${signature} to service_role;`);
    assertBefore(sql, `revoke all on function ${signature}`, `grant execute on function ${signature}`);
    // Any grant naming a browser role would let a phone reserve attempts or
    // write costs directly.
    const browserGrant = new RegExp(`grant [^;]*on function public\\.${name}\\b[^;]*\\b(anon|authenticated|public)\\b`, "i");
    assert.doesNotMatch(sql, browserGrant, `${name} must not be granted to a browser role`);
  }
});

test("migration presence: get_player_battle_state is granted like the other player RPCs (anon, authenticated) and nothing else", () => {
  assertContains(sql, "grant execute on function public.get_player_battle_state(text, text) to anon, authenticated;");
  const grants = [...sql.matchAll(/grant [^;]*;/gi)].map((match) => match[0]);
  // Exactly the four execute grants above, and no table grants at all: the
  // functions are security definer, so no role needs a new table privilege.
  assert.equal(grants.length, 4, `expected 4 grants, saw: ${grants.join(" | ")}`);
  assert.ok(grants.every((grant) => /^grant execute on function /.test(grant)), "only function execute grants are expected");
});

test("migration presence: authorize verifies membership, battle_prompt phase, and an existing entry", () => {
  const body = functionBody("authorize_battle_generation");
  assertContains(body, "and p.player_token_hash = public.token_hash(p_player_token)");
  assertContains(body, "if not found then raise exception 'Player is not in this room'; end if;");
  assertContains(body, "if active_session.phase::text <> 'battle_prompt' then raise exception 'Image generation is not open'; end if;");
  // A late joiner has no entry row and gets refused, not a fresh entry.
  assertContains(body, "and e.player_id = active_player.id");
  assertContains(body, "if not found then raise exception 'You are not in a matchup this round'; end if;");
  assertNotContains(body, "insert into public.session_battle_entries");
});

test("contract: attempts cannot exceed the round's attemptBudget", () => {
  const body = functionBody("authorize_battle_generation");
  assertContains(body, "attempt_budget := (battle_engine ->> 'attemptBudget')::integer;");
  assertContains(body, "if active_entry.attempts_used >= attempt_budget then raise exception 'You have no generation attempts left'; end if;");
  assertContains(body, "update public.session_battle_entries set attempts_used = attempts_used + 1 where id = active_entry.id");
  assertBefore(body, "if active_entry.attempts_used >= attempt_budget", "update public.session_battle_entries set attempts_used = attempts_used + 1", "the budget check must precede the reservation");
  assertContains(body, "'attemptsRemaining', attempt_budget - active_entry.attempts_used");
});

test("contract: maxSessionSpendUsd null (or absent) means NO monetary cap", () => {
  const body = functionBody("authorize_battle_generation");
  // ->> yields SQL null for both a JSON null and a missing key; the cap block
  // is skipped entirely in that case. A coalesce to 0 would turn "no cap" into
  // "disabled", which is the inversion the free-engine addendum section 5 forbids.
  assertContains(body, "max_spend := (battle_engine ->> 'maxSessionSpendUsd')::numeric;");
  assertContains(body, "if max_spend is not null then");
  assertNotContains(body, "coalesce((battle_engine ->> 'maxSessionSpendUsd')");
  assertNotContains(body, "coalesce(max_spend");
});

test("contract: maxSessionSpendUsd 0 means generation DISABLED", () => {
  const body = functionBody("authorize_battle_generation");
  assertContains(body, "if max_spend <= 0 then raise exception 'Image generation is turned off for this game'; end if;");
  assertBefore(body, "if max_spend is not null then", "if max_spend <= 0 then", "the disabled check lives inside the not-null branch");
});

test("contract: the session spend cap blocks authorise", () => {
  const body = functionBody("authorize_battle_generation");
  assertContains(body, "select coalesce(sum(g.cost_usd), 0) into current_spend from public.session_battle_generations g join public.session_battle_entries ge on ge.id = g.entry_id join public.session_battle_matchups gm on gm.id = ge.matchup_id where gm.session_id = active_session.id;");
  assertContains(body, "if current_spend >= max_spend then raise exception 'This game has reached its image spending limit'; end if;");
  assertBefore(body, "if current_spend >= max_spend", "insert into public.session_battle_generations", "the spend check must precede the reservation");
});

test("contract: maxSessionGenerations is enforced when set and refunded attempts do not count", () => {
  const body = functionBody("authorize_battle_generation");
  assertContains(body, "max_generations := (battle_engine ->> 'maxSessionGenerations')::integer;");
  assertContains(body, "if max_generations is not null then");
  assertContains(body, "and g.status in ('pending', 'complete');");
  assertContains(body, "if generation_count >= max_generations then raise exception 'This game has reached its image generation limit'; end if;");
  assertBefore(body, "if generation_count >= max_generations", "insert into public.session_battle_generations");
});

test("contract: the engine comes from session state, never from the request", () => {
  const signature = raw.slice(raw.indexOf("create or replace function public.authorize_battle_generation("), raw.indexOf(")", raw.indexOf("create or replace function public.authorize_battle_generation(")));
  assert.deepEqual([...signature.matchAll(/\bp_[a-z_]+/g)].map((match) => match[0]), ["p_room_code", "p_player_token", "p_player_prompt"]);
  const body = functionBody("authorize_battle_generation");
  assertContains(body, "engine_provider := coalesce(active_session.battle_engine_provider, battle_engine ->> 'defaultProvider');");
  assertContains(body, "engine_model := coalesce(active_session.battle_engine_model, battle_engine ->> 'defaultModel');");
  assertContains(body, "battle_engine := battle_round -> 'engine';");
  assertContains(body, "from public.quiz_versions where id = active_session.quiz_version_id;");
  // The reserved row and the response both carry the session's engine.
  assertContains(body, "values ( active_entry.id, next_attempt_index, safe_prompt, engine_provider, engine_model, 'pending' )");
  assertContains(body, "'provider', engine_provider, 'model', engine_model,");
  assertContains(body, "'variants', (battle_engine ->> 'variants')::integer,");
  assertContains(body, "'resolution', battle_engine ->> 'resolution',");
  assertContains(body, "'outputFormat', battle_engine ->> 'outputFormat',");
  // No request argument other than the player's own prompt reaches the row.
  assertNotContains(body, "p_provider");
  assertNotContains(body, "p_model");
});

test("contract: authorize returns the documented generation payload", () => {
  const body = functionBody("authorize_battle_generation");
  for (const key of ["generationId", "promptText", "provider", "model", "variants", "resolution", "outputFormat", "attemptsRemaining"]) {
    assertContains(body, `'${key}', `, `authorize must return ${key}`);
  }
  assertContains(body, "'promptText', active_matchup.prompt_text,");
  assertContains(body, "returning id into new_generation_id;");
});

test("contract: concurrent authorize calls serialize on the session row, then the entry row", () => {
  const body = functionBody("authorize_battle_generation");
  // Session-wide caps (spend, generation count) need the session lock; the
  // per-entry budget is guarded twice over by also locking the entry.
  assertContains(body, "for update of s;");
  assertContains(body, "for update of e;");
  assertBefore(body, "for update of s;", "for update of e;", "lock order is session, then entry");
  assertBefore(body, "for update of e;", "if active_entry.attempts_used >= attempt_budget", "the entry must be locked before its budget is read");
  assertBefore(body, "for update of s;", "select coalesce(sum(g.cost_usd), 0) into current_spend", "the session must be locked before spend is summed");
  // The next attempt index is derived under the lock from the rows that
  // exist, so a refunded attempt's index is never reused.
  assertContains(body, "select coalesce(max(g.attempt_index) + 1, 0) into next_attempt_index from public.session_battle_generations g where g.entry_id = active_entry.id;");
});

test("contract: record is idempotent — a completed generation is returned unchanged, never re-costed", () => {
  const body = functionBody("record_battle_generation");
  assertContains(body, "from public.session_battle_generations where id = p_generation_id for update;");
  assertContains(body, "if not found then raise exception 'Generation not found'; end if;");
  assertContains(body, "if active_generation.status = 'complete' then return jsonb_build_object(");
  assertContains(body, "'recorded', false");
  assertContains(body, "if active_generation.status <> 'pending' then raise exception 'This generation was refunded and cannot be recorded'; end if;");
  assertBefore(body, "if active_generation.status = 'complete' then", "update public.session_battle_generations", "the replay return must precede the write");
  // Cost is assigned, never accumulated, and only a pending row is written.
  assertContains(body, "cost_usd = p_cost_usd");
  assertNotContains(body, "cost_usd + ");
  assertContains(body, "where id = active_generation.id and status = 'pending'");
  assertContains(body, "status = 'complete'");
  // Recording never touches the attempt count.
  assertNotContains(body, "attempts_used");
});

test("contract: record supports partial success but refuses zero assets and foreign assets", () => {
  const body = functionBody("record_battle_generation");
  assertContains(body, "if coalesce(cardinality(p_asset_ids), 0) = 0 then raise exception 'A generation with no images must be refunded, not recorded'; end if;");
  assertContains(body, "'partial', cardinality(active_generation.asset_ids) < requested_variants");
  assertContains(body, "if p_cost_usd is not null and p_cost_usd < 0 then raise exception 'Generation cost cannot be negative'; end if;");
  assertContains(body, "a.source = 'battle' and a.generated_by_player_id = generation_player_id");
  assertContains(body, "raise exception 'Generated images do not belong to this player';");
});

test("contract: refund restores the attempt and records failed or blocked with a reason", () => {
  const body = functionBody("refund_battle_attempt");
  // "is null or": a null kind would make "not in" evaluate to null, and the
  // guard would silently pass.
  assertContains(body, "if p_reason_kind is null or p_reason_kind not in ('provider_error', 'safety_block') then raise exception 'Unknown refund reason'; end if;");
  assertContains(body, "status = case when p_reason_kind = 'safety_block' then 'blocked' else 'failed' end");
  assertContains(body, "block_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 500)");
  assertContains(body, "update public.session_battle_entries set attempts_used = greatest(attempts_used - 1, 0) where id = active_generation.entry_id");
});

test("contract: refund is idempotent — a second refund does not restore a second attempt", () => {
  const body = functionBody("refund_battle_attempt");
  assertContains(body, "from public.session_battle_generations where id = p_generation_id for update;");
  assertContains(body, "if active_generation.status in ('failed', 'blocked') then return jsonb_build_object(");
  assertContains(body, "'refunded', false");
  assertContains(body, "if active_generation.status <> 'pending' then raise exception 'A completed generation cannot be refunded'; end if;");
  assertBefore(body, "if active_generation.status in ('failed', 'blocked') then", "attempts_used = greatest(attempts_used - 1, 0)", "the replay return must precede the attempt restore");
  assertBefore(body, "if active_generation.status <> 'pending' then", "attempts_used = greatest(attempts_used - 1, 0)", "only a pending row may restore an attempt");
  const restores = body.split("attempts_used - 1").length - 1;
  assert.equal(restores, 1, "the attempt is restored in exactly one place");
  assertContains(body, "for update;");
});

test("contract: get_player_battle_state returns only the caller's own entry and generations", () => {
  const body = functionBody("get_player_battle_state");
  assertContains(body, "and p.player_token_hash = public.token_hash(p_player_token)");
  assertContains(body, "if not found then raise exception 'Player is not in this room'; end if;");
  assertContains(body, "and e.player_id = active_player.id");
  assertContains(body, "where g.entry_id = active_entry.id");
  // No other player, no pairing: every session_players read is pinned to the
  // caller's token, and entries are read exactly once, filtered to the caller.
  const executable = body.slice(body.indexOf(" begin "));
  const playerReads = executable.split("public.session_players").length - 1;
  const tokenPins = executable.split("public.token_hash(p_player_token)").length - 1;
  assert.equal(playerReads, tokenPins, "each session_players read must be pinned to the caller's token");
  assert.equal(executable.split("public.session_battle_entries").length - 1, 1, "entries are read once, for the caller only");
  assertNotContains(body, "e.matchup_id = active_matchup.id");
  assertNotContains(body, "host_battle_state_payload");
});

test("contract: get_player_battle_state carries no pairing, other-player, cost or future-state fields", () => {
  const body = functionBody("get_player_battle_state");
  const keys = new Set([...body.matchAll(/'([A-Za-z]+)', /g)].map((match) => match[1]));
  assert.deepEqual(
    [...keys].sort(),
    ["assetIds", "attemptIndex", "attemptsRemaining", "entry", "generations", "phase", "promptText", "roomCode", "status"].sort()
  );
  for (const forbidden of ["cost_usd", "costUsd", "matchup_index", "matchupId", "entrants", "display_name", "playerName", "opponent", "submitted_asset_id", "vetoed_at", "session_battle_votes", "battle_shuffle_seed", "battle_engine_provider", "battle_engine_model", "block_reason", "player_prompt"]) {
    assertNotContains(body, forbidden, `get_player_battle_state must not read or return ${forbidden}`);
  }
});

test("contract: a late joiner (or any non-battle phase) gets no battle data", () => {
  const body = functionBody("get_player_battle_state");
  assertContains(body, "if active_session.phase::text not in ('battle_prompt', 'battle_review', 'battle_vote', 'battle_result') then return jsonb_build_object('roomCode', active_session.room_code, 'phase', active_session.phase, 'entry', null); end if;");
  assertContains(body, "if not found then return jsonb_build_object('roomCode', active_session.room_code, 'phase', active_session.phase, 'entry', null); end if;");
  // A read never creates an entry.
  assertNotContains(body, "insert into");
  assertNotContains(body, "update public.");
  assertNotContains(body, "for update");
});

test("migration presence: phases are compared as ::text only, never as bare enum literals", () => {
  assertNotContains(sql, "active_session.phase = ");
  assertNotContains(sql, "active_session.phase <> ");
  assertNotContains(sql, "active_session.phase != ");
  assertNotContains(sql, "active_session.phase in (");
  assertNotContains(sql, "active_session.phase not in (");
  assertContains(sql, "active_session.phase::text <> 'battle_prompt'");
});

test("migration presence: no submission, veto or vote logic in this slice", () => {
  for (const outOfScope of ["submitted_asset_id", "submitted_at", "vetoed_at", "veto_reason", "session_battle_votes", "score_events"]) {
    assertNotContains(sql, outOfScope, `${outOfScope} belongs to a later slice`);
  }
});
