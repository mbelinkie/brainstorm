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

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../supabase/migrations/0026_late_join_catch_up.sql", import.meta.url), "utf8");

test("source presence: presenter renders one title QR and a corner QR after it", () => {
  assert.match(app, /function presentationCornerJoinQr/);
  assert.match(app, /state\.presentationScreen === "title" \? "" : presentationCornerJoinQr\(\)/);
  assert.match(app, /presenter-join-qr--corner[\s\S]*data-join-qr/);
  assert.match(styles, /\.presenter-join-qr--corner canvas\{[^}]*width:144px[^}]*height:144px/);
});

test("migration presence: 0026 computes the catch-up multiplier and caps it at 2x", () => {
  assert.match(migration, /1 \+ bonus_target::numeric \/ \(total_rounds - 1\)/);
  assert.match(migration, /least\(2::numeric/);
  assert.match(migration, /late_join_target_round_index/);
  assert.match(migration, /active_session\.started_at is not null/);
});

test("migration and source presence: 0026 resolves the catch-up boost and app.js badges it", () => {
  assert.match(migration, /'lateJoinBonus'/);
  assert.match(app, /function lateJoinBonusBadge/);
  assert.match(app, /Catch-up boost/);
  assert.match(migration, /before insert on public\.score_events/);
  assert.match(migration, /greatest\(coalesce\(new\.multiplier, 1\), catch_up_multiplier\)/);
  assert.match(migration, /new\.points := round\(new\.base_points \* combined_multiplier, 2\)/);
});
