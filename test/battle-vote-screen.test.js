import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  battleVoteMarkup,
  battleVoteRenderKey,
  battleVoteView,
  classifyVoteError,
  publicBattleResult,
  publicBattleVote,
  sanitizePublicBattleResult,
  sanitizePublicBattleVote,
} from "../battle-vote.js";

// Issue #31: voters see unlabelled images and tap one; entrants see an
// on-stage screen; late joiners can vote. The real host payload and real RPCs
// are exercised by test/battle-privacy-contract.test.js; these tests cover the
// phone's view logic and markup, which app.js renders verbatim.

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const E1 = "e1000000-0000-4000-8000-000000000000", E2 = "e2000000-0000-4000-8000-000000000000", E3 = "e3000000-0000-4000-8000-000000000000";
const A1 = "a1000000-0000-4000-8000-000000000000", A2 = "a2000000-0000-4000-8000-000000000000", A3 = "a3000000-0000-4000-8000-000000000000";
const M = "m0000000-0000-4000-8000-000000000000";

// Shaped like host_battle_state_payload (0041): entrants ordered by name.
const hostPayload = {
  matchups: [{
    matchupId: M, matchupIndex: 0, promptText: "Draw a cat", votesCast: 2,
    entrants: [
      { entryId: E3, playerId: "p-ada", playerName: "Ada", submittedAssetId: A3, viable: true, vetoed: false },
      { entryId: E1, playerId: "p-bo", playerName: "Bo", submittedAssetId: A1, viable: true, vetoed: false },
      { entryId: E2, playerId: "p-cy", playerName: "Cy", submittedAssetId: A2, viable: false, vetoed: true },
    ],
  }],
};

const ballot = publicBattleVote(hostPayload, 0);

test("the public ballot carries only viable images, in entry-ID order, with no names or counts", () => {
  assert.deepEqual(ballot, { matchupId: M, matchupIndex: 0, promptText: "Draw a cat", entries: [{ entryId: E1, assetId: A1 }, { entryId: E3, assetId: A3 }] });
  assert.equal(publicBattleVote(hostPayload, 1), null, "no such matchup");
  const text = JSON.stringify(ballot);
  for (const forbidden of ["Ada", "Bo", "Cy", "p-ada", "votesCast", A2]) assert.ok(!text.includes(forbidden), forbidden);
});

test("publicRoomState's whitelist strips anything a host might assign by mistake", () => {
  const sloppy = { ...hostPayload.matchups[0], entries: hostPayload.matchups[0].entrants.map((entrant) => ({ ...entrant, assetId: entrant.submittedAssetId })) };
  const cleaned = sanitizePublicBattleVote(sloppy);
  assert.deepEqual(cleaned, ballot, "names, player IDs, counts and the vetoed entry are all stripped");
  assert.equal(sanitizePublicBattleVote({ matchupId: M, entries: [] }), null, "no matchup index: dropped, not forwarded");
  const withExtras = { ...ballot, votesCast: 3, entries: ballot.entries.map((entry) => ({ ...entry, playerName: "Ada", votes: 3 })) };
  assert.deepEqual(sanitizePublicBattleVote(withExtras), ballot);
  assert.equal(sanitizePublicBattleVote(null), null);
});

test("the public result reveals creators and counts, never player IDs", () => {
  const resolution = {
    matchupId: M, matchupIndex: 0, outcome: "winner", votesCast: 3,
    entries: [
      { entryId: E3, playerId: "p-ada", playerName: "Ada", assetId: A3, votes: 2, viable: true, winner: true },
      { entryId: E1, playerId: "p-bo", playerName: "Bo", assetId: A1, votes: 1, viable: true, winner: false },
      { entryId: E2, playerId: "p-cy", playerName: "Cy", assetId: A2, votes: 0, viable: false, winner: false },
    ],
  };
  const result = publicBattleResult(resolution);
  assert.deepEqual(result.entries.map((entry) => [entry.playerName, entry.votes, entry.winner]), [["Bo", 1, false], ["Ada", 2, true]]);
  assert.ok(!JSON.stringify(result).includes("p-ada"));
  assert.deepEqual(sanitizePublicBattleResult(result), result, "sanitizing a clean result changes nothing");
});

test("vote errors map to confirmed, rejected or retryable", () => {
  assert.equal(classifyVoteError(new Error("You have already voted in this matchup")).status, "confirmed");
  for (const message of ["Voting is not open: this round is not in the battle_vote phase", "That matchup is not the current matchup for this round", "That entry was vetoed and cannot be voted for", "That entry image is not a valid battle asset for this matchup", "You have left this room and cannot vote"]) {
    assert.equal(classifyVoteError(new Error(message)).status, "rejected", message);
  }
  assert.match(classifyVoteError(new Error("Entrants of the current matchup cannot vote in their own matchup")).message, /You are in this matchup/);
  assert.equal(classifyVoteError(new Error("Failed to fetch")).status, "retryable");
  assert.equal(classifyVoteError(undefined).status, "retryable");
});

test("each phase and role gets its own screen", () => {
  const base = { battleVote: ballot, matchupIndex: 0, ownAssetIds: new Set() };
  assert.equal(battleVoteView({ ...base, phase: "battle_review" }).kind, "review-wait");
  assert.equal(battleVoteView({ ...base, phase: "battle_vote", battleVote: null }).kind, "vote-wait", "ballot not broadcast yet");
  assert.equal(battleVoteView({ ...base, phase: "battle_vote", matchupIndex: 1 }).kind, "vote-wait", "ballot is for another matchup");
  assert.equal(battleVoteView({ ...base, phase: "battle_vote", ownAssetIds: new Set([A3]) }).kind, "on-stage", "an entrant recognises their own image");
  assert.equal(battleVoteView({ ...base, phase: "battle_vote" }).kind, "vote", "voters, including late joiners with no images");
  assert.equal(battleVoteView({ ...base, phase: "battle_result" }).kind, "result-wait");
  assert.equal(battleVoteView({ ...base, phase: "battle_prompt" }).kind, "none");
});

test("the ballot moves through idle, pending, confirmed, rejected and retryable", () => {
  const base = { phase: "battle_vote", battleVote: ballot, matchupIndex: 0 };
  const idle = battleVoteView(base);
  assert.deepEqual([idle.status, idle.canVote, idle.entries.map((entry) => entry.letter)], ["idle", true, ["A", "B"]]);
  const pending = battleVoteView({ ...base, vote: { matchupId: M, entryId: E1, status: "pending" } });
  assert.deepEqual([pending.status, pending.canVote, pending.chosenEntryId], ["pending", false, E1]);
  const confirmed = battleVoteView({ ...base, vote: { matchupId: M, entryId: E1, status: "confirmed" } });
  assert.equal(confirmed.canVote, false);
  assert.match(battleVoteMarkup(confirmed, escapeHtml), /Vote counted/);
  const rejected = battleVoteView({ ...base, vote: { matchupId: M, entryId: E1, status: "rejected", message: "Voting on this matchup has closed." } });
  assert.equal(rejected.canVote, false);
  assert.match(battleVoteMarkup(rejected, escapeHtml), /role="alert">Voting on this matchup has closed/);
  const retryable = battleVoteView({ ...base, vote: { matchupId: M, entryId: E1, status: "retryable", message: "Your vote did not go through. Try again." } });
  assert.equal(retryable.canVote, true);
  const stale = battleVoteView({ ...base, vote: { matchupId: "older", entryId: E1, status: "confirmed" } });
  assert.equal(stale.status, "idle", "a vote on a previous matchup does not carry over");
});

test("the voting branch shows no creator, count or other-matchup data", () => {
  const markup = battleVoteMarkup(battleVoteView({ phase: "battle_vote", battleVote: ballot, matchupIndex: 0 }), escapeHtml);
  for (const forbidden of ["Ada", "Bo", "Cy", "vote count", "votes", A2, E2]) assert.ok(!markup.includes(forbidden), forbidden);
  assert.match(markup, new RegExp(`data-battle-vote="${E1}"`));
  assert.match(markup, new RegExp(`data-battle-vote-image="${A1}"`));
  assert.ok(!/ src=/.test(markup), "images load through the media proxy");
  const stage = battleVoteMarkup(battleVoteView({ phase: "battle_vote", battleVote: ballot, matchupIndex: 0, ownAssetIds: new Set([A1]) }), escapeHtml);
  assert.ok(!/data-battle-vote|data-battle-vote-image/.test(stage), "the on-stage screen offers no ballot and no images");
});

test("the result screen names creators, marks the winner, the phone's own entry and its vote", () => {
  const broadcast = publicBattleResult({
    matchupId: M, matchupIndex: 0, outcome: "winner", votesCast: 3,
    entries: [{ entryId: E3, playerName: "Ada <3", assetId: A3, votes: 2, viable: true, winner: true }, { entryId: E1, playerName: "Bo", assetId: A1, votes: 1, viable: true, winner: false }],
  });
  const asVoter = battleVoteView({ phase: "battle_result", battleResult: broadcast, matchupIndex: 0, vote: { matchupId: M, entryId: E3, status: "confirmed" } });
  const markup = battleVoteMarkup(asVoter, escapeHtml);
  assert.match(markup, /Ada &lt;3/);
  assert.match(markup, /2 votes · Winner · Your vote/);
  assert.match(markup, /1 vote</);
  const asLoser = battleVoteView({ phase: "battle_result", battleResult: broadcast, matchupIndex: 0, ownAssetIds: new Set([A1]) });
  assert.deepEqual([asLoser.onStage, asLoser.iWon], [true, false]);
  assert.match(battleVoteMarkup(asLoser, escapeHtml), /Bo \(you\)/);
  const asWinner = battleVoteView({ phase: "battle_result", battleResult: broadcast, matchupIndex: 0, ownAssetIds: new Set([A3]) });
  assert.match(battleVoteMarkup(asWinner, escapeHtml), /You won this matchup!/);
  const skipped = battleVoteView({ phase: "battle_result", battleResult: { ...broadcast, outcome: "skipped", entries: [] }, matchupIndex: 0 });
  assert.match(battleVoteMarkup(skipped, escapeHtml), /skipped/);
});

test("the render key changes with the ballot state, not with unrelated room updates", () => {
  const base = { phase: "battle_vote", battleVote: ballot, matchupIndex: 0 };
  const key = battleVoteRenderKey(battleVoteView(base));
  assert.equal(battleVoteRenderKey(battleVoteView({ ...base })), key);
  assert.notEqual(battleVoteRenderKey(battleVoteView({ ...base, vote: { matchupId: M, entryId: E1, status: "pending" } })), key);
});

// --- app.js wiring ---------------------------------------------------------

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const withoutLineComments = (source) => source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");

test("the phone's voting branch precedes any question rendering and reads no host data", () => {
  const renderPlayer = withoutLineComments(app.slice(app.indexOf("function renderPlayer() {"), app.indexOf("\nfunction render() {")));
  const branch = renderPlayer.indexOf('if (["battle_review", "battle_vote", "battle_result"].includes(state.phase)) {');
  assert.ok(branch > 0);
  const firstQuestion = renderPlayer.indexOf("state.question");
  assert.ok(firstQuestion === -1 || branch < firstQuestion);
  const block = app.slice(app.indexOf("// --- Prompt Battle voting and result, phone side (issue #31)"), app.indexOf("function renderPlayer() {"));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /hostSecret|getHostBattleState|battleRoundPanel|resolveBattleMatchup/);
  assert.match(block, /roomApi\.castBattleVote\(\{ roomCode, playerToken: playerId, matchupId, entryId \}\)/);
});

test("the player render key includes the ballot and the result (mistakes.md #14, #15)", () => {
  const key = app.slice(app.indexOf("function playerRenderKey("), app.indexOf("\n}\n", app.indexOf("function playerRenderKey(")));
  assert.match(key, /battleVote: roomState\?\.battleVote,/);
  assert.match(key, /battleResult: roomState\?\.battleResult,/);
});

test("room-api exposes the vote and deploy ships the module", () => {
  const roomApi = fs.readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
  assert.match(roomApi, /castBattleVote\(\{ roomCode, playerToken, matchupId, entryId \}\) \{\s*return call\("cast_battle_vote", \{ p_room_code: roomCode, p_player_token: playerToken, p_matchup_id: matchupId, p_entry_id: entryId \}\);/);
  assert.match(fs.readFileSync(new URL("../prepare-deploy.mjs", import.meta.url), "utf8"), /"battle-vote\.js"/);
});

// --- full-screen viewer -------------------------------------------------

test("tapping a ballot image expands it; only the Vote button casts a vote", () => {
  const markup = battleVoteMarkup(battleVoteView({ phase: "battle_vote", battleVote: ballot, matchupIndex: 0 }), escapeHtml);
  assert.match(markup, /Tap an image to see it full screen, then vote\./);
  const expandButtons = [...markup.matchAll(/<button[^>]*data-battle-expand="(\d)"[^>]*>/g)];
  assert.deepEqual(expandButtons.map((match) => match[1]), ["0", "1"]);
  for (const [tag] of expandButtons) assert.doesNotMatch(tag, /data-battle-vote=/, "an image tap must never vote");
  assert.match(markup, new RegExp(`data-battle-vote="${E1}"[^>]*>Vote for A<`));
  assert.ok(!markup.includes("data-battle-lightbox"), "closed by default");
});

test("the full-screen ballot shows one image, steps between them, and can vote", () => {
  const view = battleVoteView({ phase: "battle_vote", battleVote: ballot, matchupIndex: 0, expandedIndex: 1 });
  const markup = battleVoteMarkup(view, escapeHtml);
  assert.match(markup, /role="dialog" aria-modal="true" aria-label="Image B, full screen"/);
  assert.match(markup, new RegExp(`data-battle-lightbox-image="${A3}"`));
  assert.match(markup, /Image B · 2 of 2/);
  assert.match(markup, /data-battle-lightbox-step="-1" aria-label="Previous image" >/);
  assert.match(markup, /data-battle-lightbox-step="1" aria-label="Next image" disabled/);
  assert.match(markup, new RegExp(`class="btn battle-lightbox-action" data-battle-vote="${E3}" >Vote for B<`));
  const voted = battleVoteMarkup(battleVoteView({ phase: "battle_vote", battleVote: ballot, matchupIndex: 0, expandedIndex: 1, vote: { matchupId: M, entryId: E3, status: "confirmed" } }), escapeHtml);
  assert.match(voted, /data-battle-vote="[^"]+" disabled>✓ Your vote</);
  assert.equal(battleVoteView({ phase: "battle_vote", battleVote: ballot, matchupIndex: 0, expandedIndex: 5 }).expandedIndex, null, "an out-of-range index is closed");
});

test("the generation grid expands too, with favourite in the full-screen view", async () => {
  const { battlePlayerMarkup, battlePlayerView, initialBattlePlayer } = await import("../battle-player.js");
  const battle = { ...initialBattlePlayer("round-0"), entry: { promptText: "Draw a cat", attemptsRemaining: 2, generations: [{ attemptIndex: 1, status: "complete", assetIds: [A1, A2] }] }, favouriteAssetId: A2 };
  const closed = battlePlayerMarkup(battlePlayerView(battle), escapeHtml);
  assert.match(closed, /Tap an image to see it full screen\./);
  for (const [tag] of closed.matchAll(/<button[^>]*data-battle-expand="\d"[^>]*>/g)) assert.doesNotMatch(tag, /data-battle-favourite=/);
  const open = battlePlayerMarkup(battlePlayerView(battle, { expandedIndex: 1 }), escapeHtml);
  assert.match(open, /aria-label="Image 2, full screen"/);
  assert.match(open, new RegExp(`class="btn battle-lightbox-action" data-battle-favourite="${A2}" >★ Your favourite<`));
  const first = battlePlayerMarkup(battlePlayerView(battle, { expandedIndex: 0 }), escapeHtml);
  assert.match(first, new RegExp(`data-battle-favourite="${A1}" >☆ Make this my favourite<`));
});
