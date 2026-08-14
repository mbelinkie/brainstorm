import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync(new URL("../cloudflare-worker.js", import.meta.url), "utf8");
test("private media requires room credentials and authorization RPC", () => {
  assert.match(worker, /\(!hostSecret && !playerToken\)/);
  assert.match(worker, /can_access_live_media/);
  assert.match(worker, /cache-control.*private, no-store/);
});

test("private media sends the Supabase server credential as an API key", () => {
  assert.match(worker, /apikey: secret/);
});

test("private media failures expose a safe diagnostic stage", () => {
  assert.match(worker, /x-quiz-media-stage/);
  assert.match(worker, /storage-download/);
});
test("reveal-only media authorization is phase-gated", () => {
  const migration = fs.readFileSync(new URL("../supabase/migrations/0018_reveal_image_access.sql", import.meta.url), "utf8");
  assert.match(migration, /active_session\.phase = 'answer_reveal'/);
  assert.match(migration, /revealImageAssetId/);
});
test("ordinary question images are authorized for joined players", () => {
  const migration = fs.readFileSync(new URL("../supabase/migrations/0020_question_image_access.sql", import.meta.url), "utf8");
  assert.match(migration, /questionImageAssetId/);
  assert.match(migration, /answer_reveal/);
});
test("media assistant requires author authentication", () => {
  assert.match(worker, /Sign in as an authorized quiz author first/);
  assert.match(worker, /verifyQuizAuthor/);
  assert.match(worker, /rpc\/is_quiz_author/);
});
test("author media previews require an authenticated allowlisted author", () => {
  assert.match(worker, /\/author-media\//);
  assert.match(worker, /author-session/);
  assert.match(worker, /author-denied/);
  assert.match(worker, /rpc\/is_quiz_author/);
});
test("media routes bypass the static-asset handler", () => {
  const config = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /run_worker_first/);
  assert.match(config, /media-assistant/);
  assert.match(config, /author-media/);
  assert.match(config, /media-health/);
});
test("anonymous text-answer wall is host authorized and excludes player identity", () => {
  assert.match(worker, /\/host-text-answers/);
  assert.match(worker, /get_host_live_room_state/);
  assert.match(worker, /get_host_text_answers/);
  assert.doesNotMatch(worker.slice(worker.indexOf('url.pathname === "/host-text-answers"'), worker.indexOf('url.pathname === "/media-assistant/search"')), /display_name|player_id/);
});
