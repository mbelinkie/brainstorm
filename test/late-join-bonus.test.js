import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../supabase/migrations/0026_late_join_catch_up.sql", import.meta.url), "utf8");

test("presenter keeps one QR on the title page and a large corner QR after it", () => {
  assert.match(app, /function presentationCornerJoinQr/);
  assert.match(app, /state\.presentationScreen === "title" \? "" : presentationCornerJoinQr\(\)/);
  assert.match(app, /presenter-join-qr--corner[\s\S]*data-join-qr/);
  assert.match(styles, /\.presenter-join-qr--corner canvas\{[^}]*width:144px[^}]*height:144px/);
});

test("late join boost scales with elapsed rounds and caps at 2x", () => {
  assert.match(migration, /1 \+ bonus_target::numeric \/ \(total_rounds - 1\)/);
  assert.match(migration, /least\(2::numeric/);
  assert.match(migration, /late_join_target_round_index/);
  assert.match(migration, /active_session\.started_at is not null/);
});

test("catch-up boost is private, visible to its player, and server-authoritative", () => {
  assert.match(migration, /'lateJoinBonus'/);
  assert.match(app, /function lateJoinBonusBadge/);
  assert.match(app, /Catch-up boost/);
  assert.match(migration, /before insert on public\.score_events/);
  assert.match(migration, /greatest\(coalesce\(new\.multiplier, 1\), catch_up_multiplier\)/);
  assert.match(migration, /new\.points := round\(new\.base_points \* combined_multiplier, 2\)/);
});
