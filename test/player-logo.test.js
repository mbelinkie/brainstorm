import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../kaplan-brand-layer.css", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/0021_player_logos.sql", import.meta.url), "utf8");

test("players select a square logo before joining", () => {
  assert.match(app, /name="player-logo"/);
  assert.match(app, /player-logo-picker/);
  assert.match(app, /sessionStorage\.setItem\("quizPlayerLogoKey"/);
  assert.match(api, /p_logo_key: logoKey/);
});

test("all scoreboard variants render player logos", () => {
  assert.match(app, /player-logo--host/);
  assert.match(app, /player-logo--presentation/);
  assert.match(app, /player-logo--mini/);
  assert.match(css, /aspect-ratio:\s*1/);
});

test("hosted leaderboards persist and return stable logo keys", () => {
  assert.match(migration, /add column if not exists logo_key/);
  assert.match(migration, /'logoKey', player\.logo_key/);
  assert.match(migration, /logo_key = excluded\.logo_key/);
});

test("all supplied player avatars are optimized square PNG assets", () => {
  const avatarDirectory = new URL("../assets/player-icons/", import.meta.url);
  const files = readdirSync(avatarDirectory).filter((name) => /^avatar-\d{2}\.png$/.test(name)).sort();
  assert.equal(files.length, 19);
  for (const file of files) {
    const png = readFileSync(new URL(file, avatarDirectory));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 256);
  }
});
