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
  // The chosen logo is persisted with the rest of the identity, under the room
  // code, by savePlayerIdentity() -- see the room-scoping tests below.
  assert.match(app, /playerLogoKey = normalizePlayerLogoKey\(document\.querySelector\('input\[name="player-logo"\]:checked'\)\?\.value\)/);
  assert.match(app, /logoKey: playerLogoKey/);
  assert.match(api, /p_logo_key: logoKey/);
});

test("a player identity survives closing the browser and rejoining from the room QR", () => {
  // Must-not-regress: a screen lock, an evicted tab, or an accidentally closed
  // tab has to be recoverable by rescanning the SAME room's QR code, landing
  // the player back on their existing score with their own player token.
  assert.match(app, /function persistedPlayerValue\(key\)/);
  assert.match(app, /localStorage\.getItem\(key\) \|\| sessionStorage\.getItem\(key\)/);
  assert.match(app, /let playerId = savedPlayerIdentity\?\.playerId \|\| crypto\.randomUUID\(\)/);
  assert.match(app, /rememberDoorPlayerRecord\(joined\.playerId\)/);
  // The auto-rejoin branch still resumes with the stored token, so the server
  // returns the existing player row instead of minting a second one.
  assert.match(app, /roomApi\.joinRoom\(\{ roomCode, displayName: playerName, playerToken: playerId, logoKey: playerLogoKey \}\)/);
});

test("the saved identity is read for the current room only, so a different room asks for a name again", () => {
  // The reported bug: scanning a QR for an unrelated room reused the previous
  // game's name and logo, because the saved identity was one flat set of keys
  // with a TTL and no room scoping at all. The identity must now be looked up
  // BY ROOM CODE; the TTL is enforced per room inside that lookup.
  assert.match(app, /import \{[^}]*playerIdentityForRoom[^}]*\} from "\.\/quiz-core\.js"/);
  assert.match(app, /import \{[^}]*writePlayerIdentityForRoom[^}]*\} from "\.\/quiz-core\.js"/);
  assert.match(app, /playerIdentityForRoom\(localStorage\.getItem\(PLAYER_IDENTITY_KEY\), roomCode\)/);
  assert.match(app, /let playerName = savedPlayerIdentity\?\.playerName \|\| ""/);
  assert.match(app, /let playerLogoKey = normalizePlayerLogoKey\(savedPlayerIdentity\?\.logoKey\)/);
  // Every identity write is scoped to the current room, so activity in one
  // room never refreshes or overwrites another room's entry.
  assert.match(app, /writePlayerIdentityForRoom\(localStorage\.getItem\(PLAYER_IDENTITY_KEY\), roomCode, \{ playerId, playerName, logoKey: playerLogoKey \}\)/);
  // The old global, room-blind activity key must be gone as a live mechanism.
  assert.doesNotMatch(app, /const PLAYER_SESSION_ACTIVITY_KEY = "musicTriviaPlayerSessionAt";\nif \(isPlayerSessionExpired/);
});

test("the 6-hour TTL still applies, and a join, name/logo pick, or door pick refreshes it", () => {
  // 22f24c3's TTL is correct for what it does and is layered under the room
  // keying, not replaced: quiz-core.js's store expires each room's entry with
  // isPlayerSessionExpired, and app.js restamps on every identity write.
  assert.match(app, /import \{[^}]*isPlayerSessionExpired[^}]*\} from "\.\/quiz-core\.js"/);
  assert.match(app, /function savePlayerIdentity\(\)/);
  const joinHandler = app.match(/\[data-join-room\][\s\S]{0,1200}?\n  \}\);/)?.[0];
  assert.ok(joinHandler, "expected a [data-join-room] click handler");
  assert.match(joinHandler, /savePlayerIdentity\(\)/, "picking a name and logo must persist the identity for this room");
  const doorRecord = app.match(/function rememberDoorPlayerRecord\(id\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(doorRecord, "expected rememberDoorPlayerRecord");
  assert.match(doorRecord, /savePlayerIdentity\(\)/, "a door pick must refresh this room's activity stamp");
});

test("the legacy unkeyed identity is migrated onto the current room only with proof it belongs here", () => {
  // Phones in the wild still hold the old flat keys. Dropping them outright
  // would sign every player out mid-deploy, so they are adopted onto the
  // current room -- but only when quiz-door-player:<roomCode>, which is
  // already room-keyed and written on every successful join, proves this
  // device actually joined THIS room. The TTL still gates it, and the legacy
  // keys are removed either way so the migration runs at most once.
  const migration = app.match(/function migrateLegacyPlayerIdentity\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(migration, "expected a one-shot legacy identity migration");
  assert.match(migration, /isPlayerSessionExpired\(lastActiveAt\)/, "an expired legacy identity must not be adopted");
  assert.match(migration, /params\.has\("room"\)/, "there is no room to attribute a legacy identity to outside a room");
  assert.match(migration, /persistedPlayerValue\(`quiz-door-player:\$\{roomCode\}`\)/, "adoption requires proof this device joined this room");
  assert.match(migration, /localStorage\.removeItem\(key\)[\s\S]*?sessionStorage\.removeItem\(key\)/, "legacy keys must be cleared from both storages");
  assert.match(migration, /lastActiveAt: Number\(lastActiveAt\)/, "the original activity stamp is carried over, not refreshed");
  // The migration has to run before the identity is read, or a stale name
  // would still auto-fill the join screen this one time.
  assert.ok(app.indexOf("migrateLegacyPlayerIdentity();") < app.indexOf("const savedPlayerIdentity = playerIdentityForRoom"), "expected the migration to run before the identity is read");
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
