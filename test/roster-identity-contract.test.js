import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// get_live_leaderboard() (supabase/migrations/0021_player_logos.sql) keys
// every roster row by session_players.id — the UUID join_live_room()
// returns and app.js remembers via rememberDoorPlayerRecord(joined.playerId)
// into `doorPlayerRecordId`. The module-level `playerId` variable is a
// different, locally generated credential used only to authenticate RPCs
// (submitAnswer's playerToken, joinRoom's playerToken).
//
// Broadcasting the raw token instead of the server id as a submission's or
// presence event's `playerId` makes the host's acceptSubmission/
// acceptPlayerPresence guards (`state.players.find/some(p => p.id ===
// payload.playerId)`) never match the entries state.players already holds
// from getLeaderboard() — so every question after the first leaderboard
// refresh adds a duplicate "ghost" roster entry per real player. That is
// the confirmed root cause of the host's "answers received" denominator
// sometimes reading roughly double the actual connected-player count
// (e.g. 6/12 for 6 real players); see docs/CLAUDE_WORKLOG.md.
test("submission broadcasts use the server-issued roster id, not the raw local auth token", () => {
  const fn = app.slice(app.indexOf("function sendSubmission"), app.indexOf("function announceAudioEnded"));
  assert.notEqual(fn.indexOf("function sendSubmission"), -1);
  assert.match(fn, /playerId:\s*doorPlayerRecordId\s*\|\|\s*playerId/);
});

test("presence broadcasts use the server-issued roster id, not the raw local auth token", () => {
  const fn = app.slice(app.indexOf("function announcePlayerPresence"), app.indexOf("function acceptPlayerPresence"));
  assert.notEqual(fn.indexOf("function announcePlayerPresence"), -1);
  assert.match(fn, /playerId:\s*doorPlayerRecordId\s*\|\|\s*playerId/);
});

test("every join flow records the server roster id before announcing presence", () => {
  // Both the returning-player auto-join (connectHostedRoom) and the
  // join-screen button handler must call rememberDoorPlayerRecord() with
  // the server's response before the first announcePlayerPresence() call,
  // or that first presence broadcast would fall back to the raw token.
  const joinSequences = [...app.matchAll(/rememberDoorPlayerRecord\(joined\.playerId\);[\s\S]{0,220}?announcePlayerPresence\(\);/g)];
  assert.equal(joinSequences.length, 2, "expected both join flows (auto-join and the join-screen button) to record the server id before broadcasting presence");
});
