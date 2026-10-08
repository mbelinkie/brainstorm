import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// room-api reads browser config at module load, but these contract tests never
// construct a Supabase client or send a request.
globalThis.window ||= {};
const { playerBattleSubmissionStatus, submitBattleEntryAndConfirm } = await import("../room-api.js");

const ASSET = "11111111-1111-4111-8111-111111111111";

test("player submission status accepts only the server's open, submitted, and forfeited values", () => {
  assert.equal(playerBattleSubmissionStatus({ submissionStatus: "open" }), "open");
  assert.equal(playerBattleSubmissionStatus({ submissionStatus: "submitted" }), "submitted");
  assert.equal(playerBattleSubmissionStatus({ submissionStatus: "forfeited" }), "forfeited");
  assert.equal(playerBattleSubmissionStatus({}), "unknown");
  assert.equal(playerBattleSubmissionStatus({ submissionStatus: "not-submitted" }), "unknown");
  assert.equal(playerBattleSubmissionStatus(null), "unknown");
});

test("submit contract confirms only the selected asset returned by the server", async () => {
  const result = await submitBattleEntryAndConfirm({
    roomCode: "ABC123",
    playerToken: "test-token",
    assetId: ASSET,
    client: { submitBattleEntry: async (input) => {
      assert.deepEqual(input, { roomCode: "ABC123", playerToken: "test-token", assetId: ASSET });
      return { entryId: "entry-1", submittedAssetId: ASSET, submittedAt: "2026-10-07T12:00:00Z" };
    } },
  });
  assert.equal(result.status, "confirmed");
  assert.equal(result.result.submittedAssetId, ASSET);
});

test("a mismatched or missing RPC result stays unconfirmed", async () => {
  for (const reply of [{ submittedAssetId: "22222222-2222-4222-8222-222222222222" }, null]) {
    const result = await submitBattleEntryAndConfirm({
      roomCode: "ABC123", playerToken: "test-token", assetId: ASSET,
      client: { submitBattleEntry: async () => reply },
    });
    assert.equal(result.status, "unconfirmed");
  }
});

test("submission errors separate retryable transport failures from server rejections", async () => {
  const retryable = await submitBattleEntryAndConfirm({
    roomCode: "ABC123", playerToken: "test-token", assetId: ASSET,
    client: { submitBattleEntry: async () => { throw new TypeError("offline"); } },
  });
  assert.equal(retryable.status, "retryable");

  const serverError = Object.assign(new Error("Submissions are closed for this round"), { code: "P0001" });
  const rejected = await submitBattleEntryAndConfirm({
    roomCode: "ABC123", playerToken: "test-token", assetId: ASSET,
    client: { submitBattleEntry: async () => { throw serverError; } },
  });
  assert.equal(rejected.status, "rejected");
});

test("the player RPC wrapper sends only the room credential and chosen asset", () => {
  const source = fs.readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
  assert.match(source, /submitBattleEntry\(\{ roomCode, playerToken, assetId \}\) \{\s*return call\("submit_battle_entry", \{ p_room_code: roomCode, p_player_token: playerToken, p_asset_id: assetId \}\);/);
});
