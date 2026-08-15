import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const scoringSql = fs.readFileSync(new URL("../supabase/migrations/0030_multi_fill_in_the_blank_scoring.sql", import.meta.url), "utf8");
test("server scoring contract covers all authored answer families", () => {
  for (const type of ["single_choice", "multiple_choice", "short_answer", "fill_in_the_blank", "multi_fill_in_the_blank", "arrange_in_order", "categorize", "matching", "closest_number"]) assert.match(scoringSql, new RegExp(type));
  assert.match(scoringSql, /awarded_points := correct_pair_count \*/);
  assert.match(scoringSql, /pointsPerBlank/);
  assert.match(scoringSql, /clip -> 'acceptedAnswers'/);
  assert.match(scoringSql, /question_id = active_session\.state ->> 'questionId'/);
  assert.match(scoringSql, /Closest number \(tied %s ways\)/);
});
