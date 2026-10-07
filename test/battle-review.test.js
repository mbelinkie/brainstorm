import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { battleReviewMarkup, firstViableBattleMatchupIndex, vetoBattleEntryAndRefresh } from "../battle-review.js";

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

test("voting selects the first server-reported viable matchup and stays disabled when none are viable", () => {
  assert.equal(firstViableBattleMatchupIndex({ matchups: [
    { matchupIndex: 0, viableEntryIds: [] },
    { matchupIndex: 3, viableEntryIds: ["entry-3"] },
    { matchupIndex: 4, viableEntryIds: ["entry-4"] }
  ] }), 3);
  assert.equal(firstViableBattleMatchupIndex({ matchups: [{ matchupIndex: 0, viableEntryIds: [] }] }), null);
  assert.equal(firstViableBattleMatchupIndex(null), null);
});

test("review markup includes each submitted image, its creator and its matching player prompt", () => {
  const markup = battleReviewMarkup({ matchups: [{
    matchupIndex: 2,
    promptText: "<theme>",
    skipped: false,
    entrants: [
      { entryId: "e1", playerName: "Ada <One>", submitted: true, submittedAssetId: "asset-a", generations: [
        { assetIds: ["older-asset"], playerPrompt: "Wrong prompt" },
        { assetIds: ["asset-a"], playerPrompt: "Prompt & detail" }
      ] },
      { entryId: "e2", playerName: "Bo", submitted: true, submittedAssetId: "asset-b", vetoed: true, vetoReason: "Too bright & unsafe", generations: [
        { assetIds: ["asset-b"], playerPrompt: "Second prompt" }
      ] },
      { entryId: "e3", playerName: "Not submitted", submitted: false, generations: [] }
    ]
  }] }, escapeHtml);

  assert.equal((markup.match(/data-battle-review-image=/g) || []).length, 2);
  assert.match(markup, /Ada &lt;One&gt;/);
  assert.match(markup, /Prompt &amp; detail/);
  assert.doesNotMatch(markup, /Wrong prompt|Not submitted/);
  assert.match(markup, /data-battle-entry-id="e1"[^>]*>Veto entry/);
  assert.match(markup, /data-battle-entry-id="e2"[^>]*>Undo veto/);
  assert.match(markup, /Too bright &amp; unsafe/);
  assert.match(markup, /&lt;theme&gt;/);
});

test("review markup displays skipped matchups and disables actions while a change is pending", () => {
  const markup = battleReviewMarkup({ matchups: [{
    matchupIndex: 0, promptText: "No entries", skipped: true, entrants: []
  }, {
    matchupIndex: 1, promptText: "Has an entry", skipped: false,
    entrants: [{ entryId: "e1", playerName: "A", submitted: true, submittedAssetId: "asset", generations: [] }]
  }] }, escapeHtml, { busy: true });
  assert.match(markup, /Skipped — no viable entries/);
  assert.match(markup, /data-battle-entry-id="e1" disabled>Saving…/);
});

test("veto and undo call the RPC before refreshing authoritative review state", async () => {
  for (const veto of [true, false]) {
    const calls = [];
    const result = await vetoBattleEntryAndRefresh({
      api: { async vetoBattleEntry(args) { calls.push(["rpc", args]); return { ignoredPayload: true }; } },
      async refresh() { calls.push(["refresh"]); },
      roomCode: "ROOM42", hostSecret: "host-secret", entryId: "entry-1",
      reason: veto ? "Unsafe image" : "", veto
    });
    assert.deepEqual(calls, [
      ["rpc", { roomCode: "ROOM42", hostSecret: "host-secret", entryId: "entry-1", reason: veto ? "Unsafe image" : "", veto }],
      ["refresh"]
    ]);
    assert.deepEqual(result, { ignoredPayload: true });
  }
});

test("uncertain RPC rejection still refreshes before surfacing the error", async () => {
  const calls = [];
  const failure = new Error("response lost");
  await assert.rejects(vetoBattleEntryAndRefresh({
    api: { async vetoBattleEntry() { calls.push("rpc"); throw failure; } },
    async refresh() { calls.push("refresh"); },
    roomCode: "ROOM42", hostSecret: "host-secret", entryId: "entry-1", reason: "reason", veto: true
  }), error => error === failure);
  assert.deepEqual(calls, ["rpc", "refresh"]);
});

test("room API maps veto and undo to the host-only RPC parameters", () => {
  const source = readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
  const wrapper = source.slice(source.indexOf("  vetoBattleEntry("), source.indexOf("  // Player read of their own battle entry"));
  assert.match(wrapper, /call\("veto_battle_entry"/);
  for (const parameter of ["p_room_code: roomCode", "p_host_secret: hostSecret", "p_entry_id: entryId", "p_reason: reason", "p_veto: veto"]) {
    assert.ok(wrapper.includes(parameter), `RPC includes ${parameter}`);
  }
});

test("private review details stay outside public room state", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const publicState = source.slice(source.indexOf("function publicRoomState()"), source.indexOf("function setHostQuestion("));
  assert.match(publicState, /battleProgress: publicBattleProgress\(battleRoundPanel\.state\)/);
  assert.doesNotMatch(publicState, /battleRoundPanel\.state\.matchups|\.entrants|submittedAssetId|playerPrompt|playerName/);
  assert.match(source, /view !== "host" \|\| state\.phase !== "battle_review"/);
});
