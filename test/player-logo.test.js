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
  assert.ok(app.indexOf("player-logo-picker") < app.indexOf("player-join-action"));
  assert.match(app, /savePlayerValue\("quizPlayerLogoKey", playerLogoKey\)/);
  assert.match(api, /p_logo_key: logoKey/);
});

test("a player identity survives closing the browser and rejoining from the room QR", () => {
  assert.match(app, /function persistedPlayerValue\(key\)/);
  assert.match(app, /localStorage\.getItem\(key\) \|\| sessionStorage\.getItem\(key\)/);
  assert.match(app, /savePlayerValue\("musicTriviaPlayerId", playerId\)/);
  assert.match(app, /rememberDoorPlayerRecord\(joined\.playerId\)/);
});

test("a player identity is wiped once the session TTL has passed, so a later game asks for a name again", () => {
  assert.match(app, /import \{[^}]*isPlayerSessionExpired[^}]*\} from "\.\/quiz-core\.js"/);
  // The expiry check must run, and clear the saved identity, before that
  // identity is read into playerId/playerName/playerLogoKey -- otherwise a
  // stale name would still auto-fill the join screen this one time.
  const expiryCheckIndex = app.indexOf("isPlayerSessionExpired(localStorage.getItem(PLAYER_SESSION_ACTIVITY_KEY))");
  const identityReadIndex = app.indexOf('persistedPlayerValue("musicTriviaPlayerId")');
  assert.ok(expiryCheckIndex > -1, "expected app.js to check isPlayerSessionExpired against the stored activity timestamp");
  assert.ok(expiryCheckIndex < identityReadIndex, "expected the expiry check to run before the saved identity is read");
  assert.match(app, /localStorage\.setItem\(PLAYER_SESSION_ACTIVITY_KEY, String\(Date\.now\(\)\)\)/);
});

test("mobile logo selection uses one column with large artwork", () => {
  assert.match(css, /\.player-logo-picker>div\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.match(css, /\.player-logo-choice \.player-logo\s*\{[^}]*width:\s*min\(62vw,260px\)/);
  assert.doesNotMatch(app, /logo\.label\.replace\("Avatar ", ""\)/);
});

test("mobile logo choices don't force a zero min-height that collapses their grid row", () => {
  // .player-logo-picker>div is display:grid with implicit auto rows, and each
  // .player-logo-choice is a grid item whose only visible content is a large
  // aspect-ratio square (~62vw). An explicit `min-height: 0` on that grid item
  // defeats the row's automatic minimum size on Chromium (Android Chrome), so
  // the row collapses to near-zero height while the square artwork still
  // paints at full size and overlaps the rows below it -- a fanned stack of
  // mashed-together logos. WebKit/Safari (iPhone) sizes the row correctly
  // regardless, which is why this only showed up on Android.
  const mobilePicker = css.match(/@media \(max-width: 520px\) \{[\s\S]*?\.player-logo-picker>div[\s\S]*?\n\}/)?.[0];
  assert.ok(mobilePicker, "expected a mobile .player-logo-picker media block");
  const choiceRule = mobilePicker.match(/\.player-logo-choice\s*\{[^}]*\}/)?.[0];
  assert.ok(choiceRule, "expected a mobile .player-logo-choice rule");
  assert.doesNotMatch(choiceRule, /min-height:\s*0\b/);
});

test("player screens give identity and scoreboard logos more room", () => {
  assert.match(css, /\.player-logo--identity\s*\{[^}]*width:\s*104px/);
  assert.match(css, /\.player-mini-leaderboard \.player-logo--mini\s*\{[^}]*width:\s*min\(26vw,112px\)/);
  assert.match(css, /object-fit:\s*contain/);
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
