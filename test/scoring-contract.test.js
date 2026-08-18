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
