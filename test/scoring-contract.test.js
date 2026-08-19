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
