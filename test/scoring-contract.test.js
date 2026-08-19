import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Naming note: tests prefixed "migration presence" or "source presence" assert
// that a named rule still exists in the migration or source text they read.
// They are change detectors, not proofs of behavior — nothing here executes the
// SQL or renders a surface, so a refactor that preserves the matched strings
// while changing what they do passes. Read them as "this rule has not been
// deleted", and keep behavioral coverage in the tests that import real
// functions (quiz-core, quiz-validation, quiz-fixtures, subtitle-core,
// image-crop, answer-submission-recovery, deploy-manifest).

const scoringSql = fs.readFileSync(new URL("../supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql", import.meta.url), "utf8");
const jsonbObjectLengthSql = fs.readFileSync(new URL("../supabase/migrations/0031_jsonb_object_length.sql", import.meta.url), "utf8");
test("migration presence: 0030 names every authored answer family", () => {
  for (const type of ["single_choice", "multiple_choice", "short_answer", "fill_in_the_blank", "multi_fill_in_the_blank", "arrange_in_order", "categorize", "matching", "closest_number"]) assert.match(scoringSql, new RegExp(type));
  assert.match(scoringSql, /awarded_points := correct_pair_count \*/);
  assert.match(scoringSql, /pointsPerBlank/);
  assert.match(scoringSql, /clip -> 'acceptedAnswers'/);
  assert.match(scoringSql, /question_id = active_session\.state ->> 'questionId'/);
  assert.match(scoringSql, /Closest number \(tied %s ways\)/);
});

test("migration presence: 0031 defines jsonb_object_length", () => {
  assert.match(jsonbObjectLengthSql, /create or replace function public\.jsonb_object_length\(value jsonb\)/);
  assert.match(jsonbObjectLengthSql, /from jsonb_object_keys\(value\)/);
});

// ---------------------------------------------------------------------------
// Effective-definition checks.
//
// The tests above read one named file. These read the whole chain and keep only
// the LAST `create or replace function public.<name>` in migration order — what
// a full replay actually leaves in the database. That is the difference that
// matters here: on 2026-08-18 a hand-applied `create or replace` for
// lock_and_score_live_question diverged production from 0030 (see
// docs/2026-08-18-live-fix-state.md), and the way that reverts is a later
// migration rebuilt from an older copy of the function. A grep of 0030 or 0034
// cannot see that; this can.
//
// Still source-text assertions, not behavior: nothing here executes SQL.

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

function effectiveDefinition(functionName) {
  const marker = `create or replace function public.${functionName}`;
  let latest = null;
  for (const name of migrationFiles) {
    const sql = fs.readFileSync(new URL(name, migrationsDir), "utf8");
    const start = sql.lastIndexOf(marker);
    if (start === -1) continue;
    const bodyEnd = sql.indexOf("\n$$;", start);
    assert.notEqual(bodyEnd, -1, `${name} opens ${functionName} but never closes it with "$$;"`);
    latest = { migration: name, sql: sql.slice(start, bodyEnd) };
  }
  assert.ok(latest, `no migration defines ${functionName}`);
  return latest;
}

test("effective definition: the migration chain keeps categorize partial credit", () => {
  // Production has scored a live game with per-item categorize credit since
  // 2026-08-18. A later migration rebuilt from 0030 would revert it with no
  // conflict and no symptom until a categorize question scored everyone zero.
  const { migration, sql } = effectiveDefinition("lock_and_score_live_question");
  assert.match(sql, /pointsPerCorrectItem/, `${migration} is the newest lock_and_score_live_question and it dropped categorize partial credit`);
  assert.match(sql, /awarded_points := correct_pair_count \* coalesce\(\(active_question -> 'scoring' ->> 'pointsPerCorrectItem'\)::numeric, \(active_question ->> 'pointsPerCorrectItem'\)::numeric\)/);
  // Partial credit is opt-in: a categorize question with no pointsPerCorrectItem
  // must still fall back to all-or-nothing exactly as 0030 scored it.
  assert.match(sql, /elsif correct_pair_count = jsonb_object_length\(coalesce\(active_question -> 'correctCategories', '\{\}'::jsonb\)\)/);
});

test("effective definition: re-locking a question replaces its automatic score events", () => {
  // Finding C4. Two client paths reach this RPC twice for one question (the
  // host jump control and the set_live_room_state reopen override), and every
  // correct player kept both awards.
  const { migration, sql } = effectiveDefinition("lock_and_score_live_question");
  const deleteMatch = /delete from public\.score_events where ([^;]+);/.exec(sql);
  assert.ok(deleteMatch, `${migration} never clears prior score events, so a re-lock double-awards`);
  const predicate = deleteMatch[1];
  assert.match(predicate, /session_id = active_session\.id/);
  assert.match(predicate, /question_id = active_session\.state ->> 'questionId'/);
  // Manual host adjustments (adjust_live_score writes 'host') must survive.
  assert.match(predicate, /created_by = 'system'/, "the re-lock delete is not scoped to system events and would eat manual host adjustments");
  // It has to run before the scoring loop, or it deletes what it just wrote.
  assert.ok(
    sql.indexOf(deleteMatch[0]) < sql.indexOf("for answer_row in"),
    "the score-event delete runs after the scoring loop, which would erase the new awards"
  );
});

test("effective definition: adjust_live_score still writes host events, not system ones", () => {
  // The re-lock delete above is only safe while manual adjustments are tagged
  // 'host'. If that ever changes, the delete starts destroying host decisions.
  const { migration, sql } = effectiveDefinition("adjust_live_score");
  assert.match(sql, /'host'\)/, `${migration} no longer tags manual adjustments as host events`);
  assert.doesNotMatch(sql, /, 'system'\)/, `${migration} tags a manual adjustment as a system event; the re-lock delete in lock_and_score_live_question would destroy it`);
});

test("effective definition: door rewards resolve once and stay resolved", () => {
  // PRODUCT_SPEC promises randomized outcomes are persisted so refreshes cannot
  // reroll. The phase guard alone did not deliver that: a host setting the
  // phase back to door_choice re-randomized every already-revealed reward.
  const { migration, sql } = effectiveDefinition("reveal_live_door_rewards");
  assert.match(sql, /revealed_at is null/, `${migration} re-rolls resolved_multiplier for choices that were already revealed`);
  const loopStart = sql.indexOf("for choice_row in");
  const guard = sql.indexOf("revealed_at is null");
  assert.ok(loopStart !== -1 && guard > loopStart && guard < sql.indexOf("loop\n", loopStart), "the revealed_at guard is not on the choice-selection query");
  assert.match(sql, /revealed_at = now\(\)/, "resolved choices are never stamped, so the guard would never fire");
});

test("effective definition: a locked submission cannot be edited", () => {
  // A reopened question is `question_open` again while its rows are still
  // locked, so gating on phase alone let an answer that had already been scored
  // be rewritten.
  const { migration, sql } = effectiveDefinition("submit_live_answer");
  assert.match(sql, /is_locked/, `${migration} gates submissions on phase alone and accepts edits to locked rows`);
  assert.match(sql, /raise exception 'Your answer to this question is already locked'/);
});
