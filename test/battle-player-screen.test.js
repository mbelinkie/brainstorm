import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BATTLE_PROMPT_MAX_CHARS,
  battlePlayerKey,
  battlePlayerMarkup,
  battlePlayerRenderKey,
  battlePlayerView,
  classifyGenerateReply,
  confirmedVariants,
  initialBattlePlayer,
  settleGenerateRequest,
} from "../battle-player.js";

// Issue #23: the paired player's battle_prompt screen. Behaviour is asserted
// against battle-player.js, which app.js renders verbatim; the last tests pin
// the few app.js wiring facts that cannot be imported.

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const B1 = "33333333-3333-4333-8333-333333333333";

function battleWith(entry, overrides = {}) {
  return { ...initialBattlePlayer("round-0"), entry, ...overrides };
}
const entry = (overrides = {}) => ({ promptText: "Draw a cat", attemptsRemaining: 3, generations: [], ...overrides });

test("a new battle round starts a clean player session", () => {
  assert.equal(battlePlayerKey({ battleRoundIndex: 2 }), "round-2");
  assert.equal(battlePlayerKey({ battleRoundIndex: null }), "");
  assert.deepEqual(initialBattlePlayer("round-2"), {
    key: "round-2", loading: false, loadError: "", entry: undefined, draft: "", request: { status: "idle", message: "" }, favouriteAssetId: "",
  });
});

test("Generate replies map to what the player is told", () => {
  assert.deepEqual(classifyGenerateReply(200, { assetIds: [A1, A2], partial: false }), { status: "recorded", partial: false, assetIds: [A1, A2] });
  assert.equal(classifyGenerateReply(200, { assetIds: [] }).status, "unconfirmed", "a 2xx with no images is not a success");
  assert.deepEqual(classifyGenerateReply(422, { error: "That prompt was declined and did not use an attempt. Unsafe." }), { status: "blocked", message: "That prompt was declined and did not use an attempt. Unsafe." });
  assert.equal(classifyGenerateReply(400, { error: "Describe your image in 2048 characters or fewer." }).status, "failed");
  assert.deepEqual(classifyGenerateReply(409, { error: "You cannot generate an image right now." }), { status: "refused", message: "You cannot generate an image right now." });
  assert.deepEqual(classifyGenerateReply(502, { error: "Image generation failed. Refresh to check your attempt." }), { status: "unconfirmed", message: "Image generation failed. Refresh to check your attempt." });
  assert.equal(classifyGenerateReply(0, null).status, "unconfirmed", "no reply at all");
});

test("success is claimed only when the re-read entry lists every returned image", () => {
  const reply = classifyGenerateReply(200, { assetIds: [A1, A2] });
  const listed = entry({ generations: [{ attemptIndex: 1, status: "complete", assetIds: [A1, A2] }] });
  assert.equal(settleGenerateRequest(reply, listed).status, "confirmed");
  const missing = entry({ generations: [{ attemptIndex: 1, status: "complete", assetIds: [A1] }] });
  assert.equal(settleGenerateRequest(reply, missing).status, "unconfirmed");
  assert.equal(settleGenerateRequest(reply, null).status, "unconfirmed");
  const pendingOnly = entry({ generations: [{ attemptIndex: 1, status: "pending", assetIds: [A1, A2] }] });
  assert.equal(settleGenerateRequest(reply, pendingOnly).status, "unconfirmed");
  assert.match(settleGenerateRequest(classifyGenerateReply(200, { assetIds: [A1], partial: true }), listed).message, /Only some/);
  assert.deepEqual(settleGenerateRequest(classifyGenerateReply(422, {}), listed).status, "blocked");
});

test("the grid shows only complete generations, newest attempt first", () => {
  const variants = confirmedVariants(entry({ generations: [
    { attemptIndex: 1, status: "complete", assetIds: [A1, A2] },
    { attemptIndex: 2, status: "failed", assetIds: [] },
    { attemptIndex: 3, status: "pending", assetIds: [] },
    { attemptIndex: 4, status: "complete", assetIds: [B1] },
  ] }));
  assert.deepEqual(variants.map((variant) => variant.assetId), [B1, A1, A2]);
});

test("every screen state is distinct", () => {
  assert.equal(battlePlayerView(initialBattlePlayer("round-0")).kind, "loading");
  assert.equal(battlePlayerView({ ...initialBattlePlayer("round-0"), loadError: "Could not load" }).kind, "load-error");
  assert.equal(battlePlayerView(battleWith(null)).kind, "holding", "late joiner");

  const idle = battlePlayerView(battleWith(entry(), { draft: "a cat" }));
  assert.deepEqual([idle.kind, idle.status.kind, idle.canGenerate, idle.attemptsRemaining], ["compose", "idle", true, 3]);

  const pending = battlePlayerView(battleWith(entry(), { draft: "a cat", request: { status: "pending", message: "" } }));
  assert.deepEqual([pending.status.kind, pending.canGenerate, pending.pending], ["pending", false, true]);

  const confirmed = battlePlayerView(battleWith(entry(), { request: { status: "confirmed", message: "" } }));
  assert.equal(confirmed.status.kind, "confirmed");

  for (const status of ["failed", "refused", "unconfirmed"]) {
    const failed = battlePlayerView(battleWith(entry(), { request: { status, message: "Nope" } }));
    assert.deepEqual([failed.status.kind, failed.status.message], ["failed", "Nope"], status);
  }
  const blocked = battlePlayerView(battleWith(entry(), { request: { status: "blocked", message: "Declined" } }));
  assert.equal(blocked.status.kind, "blocked");

  const spent = battlePlayerView(battleWith(entry({ attemptsRemaining: 0 }), { draft: "a cat", request: { status: "refused", message: "x" } }));
  assert.deepEqual([spent.status.kind, spent.canGenerate], ["over-budget", false]);
});

test("Generate needs a prompt within the limit and an attempt left", () => {
  assert.equal(battlePlayerView(battleWith(entry(), { draft: "   " })).canGenerate, false);
  assert.equal(battlePlayerView(battleWith(entry(), { draft: "x".repeat(BATTLE_PROMPT_MAX_CHARS) })).canGenerate, true);
  assert.equal(battlePlayerView(battleWith(entry(), { draft: "x".repeat(BATTLE_PROMPT_MAX_CHARS + 1) })).canGenerate, false);
  assert.equal(battlePlayerView(battleWith(entry({ attemptsRemaining: 0 }), { draft: "a cat" })).canGenerate, false);
  assert.equal(battlePlayerView(battleWith(entry(), { draft: "a cat", loading: true })).canGenerate, false);
});

test("a pending generation on the server is shown as still being checked", () => {
  const view = battlePlayerView(battleWith(entry({ generations: [{ attemptIndex: 1, status: "pending", assetIds: [] }] })));
  assert.equal(view.awaitingCheck, true);
  assert.match(battlePlayerMarkup(view, escapeHtml), /still being checked/);
});

test("a favourite is marked only on one of the player's own variants", () => {
  const generations = [{ attemptIndex: 1, status: "complete", assetIds: [A1, A2] }];
  const view = battlePlayerView(battleWith(entry({ generations }), { favouriteAssetId: A2 }));
  assert.equal(view.favouriteAssetId, A2);
  const markup = battlePlayerMarkup(view, escapeHtml);
  assert.match(markup, new RegExp(`data-battle-favourite="${A2}" aria-pressed="true"`));
  assert.match(markup, new RegExp(`data-battle-favourite="${A1}" aria-pressed="false"`));
  assert.equal(battlePlayerView(battleWith(entry({ generations }), { favouriteAssetId: B1 })).favouriteAssetId, "");
});

test("the rendered branch carries only the player's own prompt and images", () => {
  // Fields a future RPC change might add must not leak through the markup.
  const leaky = entry({
    promptText: "Draw a cat",
    opponent: { playerName: "Zed Opponent", promptText: "Opponent prompt" },
    matchups: [{ promptText: "Another matchup prompt" }],
    votes: 7,
    generations: [{ attemptIndex: 1, status: "complete", assetIds: [A1], playerPrompt: "my secret words", costUsd: 0.04 }],
  });
  const markup = battlePlayerMarkup(battlePlayerView(battleWith(leaky)), escapeHtml);
  for (const forbidden of ["Zed Opponent", "Opponent prompt", "Another matchup prompt", "costUsd", "0.04", "vote"]) {
    assert.ok(!markup.toLowerCase().includes(forbidden.toLowerCase()), `markup must not contain ${forbidden}`);
  }
  assert.match(markup, /Draw a cat/);
  assert.match(markup, new RegExp(`data-battle-variant-image="${A1}"`));
  assert.ok(!/ src=/.test(markup), "images load through the media proxy, never an inline URL");
});

test("the late-join holding screen shows no prompt and no controls", () => {
  const markup = battlePlayerMarkup(battlePlayerView(battleWith(null)), escapeHtml);
  assert.ok(!/textarea|data-battle-generate|data-battle-variant/.test(markup));
  assert.match(markup, /started before you joined/);
});

test("prompt text and server messages are escaped", () => {
  const view = battlePlayerView(battleWith(entry({ promptText: "<img src=x onerror=alert(1)>" }), { draft: "</textarea><b>", request: { status: "failed", message: "<script>" } }));
  const markup = battlePlayerMarkup(view, escapeHtml);
  assert.ok(!markup.includes("<img src=x"));
  assert.ok(!markup.includes("</textarea><b>"));
  assert.ok(!markup.includes("<script>"));
});

test("the render key moves on structure, not on typing (mistakes.md #14, #15)", () => {
  const generations = [{ attemptIndex: 1, status: "complete", assetIds: [A1] }];
  const base = battleWith(entry({ generations }));
  const key = battlePlayerRenderKey(battlePlayerView(base));
  assert.equal(battlePlayerRenderKey(battlePlayerView({ ...base, draft: "typing…" })), key, "typing never redraws");
  assert.notEqual(battlePlayerRenderKey(battlePlayerView({ ...base, entry: entry({ generations, attemptsRemaining: 2 }) })), key);
  assert.notEqual(battlePlayerRenderKey(battlePlayerView({ ...base, entry: entry({ generations: [...generations, { attemptIndex: 2, status: "complete", assetIds: [B1] }] }) })), key);
  assert.notEqual(battlePlayerRenderKey(battlePlayerView({ ...base, request: { status: "pending", message: "" } })), key);
  assert.notEqual(battlePlayerRenderKey(battlePlayerView({ ...base, favouriteAssetId: A1 })), key);
});

// --- app.js wiring ---------------------------------------------------------

const appSource = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const withoutLineComments = (source) => source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
const renderPlayerSource = withoutLineComments(appSource.slice(appSource.indexOf("function renderPlayer() {"), appSource.indexOf("\nfunction render() {")));
const battleBlock = appSource.slice(appSource.indexOf("// --- Prompt Battle player screen (issue #23)"), appSource.indexOf("function renderPlayer() {"));

test("the battle check precedes any state.question rendering on the phone", () => {
  const battleBranch = renderPlayerSource.indexOf('if (state.phase === "battle_prompt") {');
  const firstQuestionRead = renderPlayerSource.indexOf("state.question");
  assert.ok(battleBranch > 0, "battle_prompt branch present");
  assert.ok(firstQuestionRead === -1 || battleBranch < firstQuestionRead, "battle branch must come before any state.question read");
  assert.match(renderPlayerSource.slice(battleBranch, battleBranch + 120), /renderPlayerBattle\(\);\s*return;/);
});

test("the phone battle code reads only the player's own state and never host data", () => {
  assert.ok(battleBlock.length > 0);
  assert.ok(!/state\.question|hostSecret|getHostBattleState|battleRoundPanel|presentationScreen/.test(battleBlock));
  assert.match(battleBlock, /roomApi\.getPlayerBattleState\(\{ roomCode, playerToken: playerId \}\)/);
  assert.match(battleBlock, /\/battle\/generate/);
  assert.match(battleBlock, /"x-quiz-player-token": playerId/);
});

test("room-api exposes the player battle read and deploy ships the module", () => {
  const roomApiSource = fs.readFileSync(new URL("../room-api.js", import.meta.url), "utf8");
  assert.match(roomApiSource, /getPlayerBattleState\(\{ roomCode, playerToken \}\) \{\s*return call\("get_player_battle_state", \{ p_room_code: roomCode, p_player_token: playerToken \}\);/);
  assert.match(roomApiSource, /submitBattleEntry\(\{ roomCode, playerToken, assetId \}\) \{\s*return call\("submit_battle_entry", \{ p_room_code: roomCode, p_player_token: playerToken, p_asset_id: assetId \}\);/);
  const deploySource = fs.readFileSync(new URL("../prepare-deploy.mjs", import.meta.url), "utf8");
  assert.match(deploySource, /"battle-player\.js"/);
});

test("submission UI is driven by the player's server status across prompt and review", () => {
  const submissionMarkup = battleBlock.slice(battleBlock.indexOf("function battleSubmissionMarkup"), battleBlock.indexOf("async function submitBattlePlayerEntry"));
  assert.ok(submissionMarkup.length > 0, "submission status markup is implemented in the player flow");
  assert.match(submissionMarkup, /playerBattleSubmissionStatus\(entry\)/);
  assert.match(submissionMarkup, /submissionStatus === "submitted"/);
  assert.match(submissionMarkup, /submissionStatus === "forfeited"/);
  assert.match(submissionMarkup, /Time.s up/i);
  assert.match(submissionMarkup, /Waiting for the host/);
  assert.match(submissionMarkup, /data-battle-submit-reload/);
  assert.doesNotMatch(submissionMarkup, /sessionStorage/);

  const submitFlow = battleBlock.slice(battleBlock.indexOf("async function submitBattlePlayerEntry"), battleBlock.indexOf("function battleVariantImageUrl"));
  assert.match(submitFlow, /status: "pending"/);
  assert.match(submitFlow, /submitBattleEntryAndConfirm/);
  assert.match(submitFlow, /status === "confirmed"/);
  for (const status of ["pending", "confirmed", "rejected", "retryable", "unconfirmed"]) {
    assert.match(submissionMarkup, new RegExp(`${status}:`), `${status} has visible feedback`);
  }
  assert.match(submitFlow, /status === "retryable"/);
  assert.match(submitFlow, /favouriteAssetId/);
});

test("refresh and phase changes reload the server-owned battle entry before submission feedback", () => {
  assert.match(battleBlock, /battlePlayerLoadedPhase === state\.phase \|\| battlePlayerLoadingPhase === state\.phase/);
  assert.match(battleBlock, /battlePlayer\.entry = result\?\.entry \?\? null/);
  assert.match(battleBlock, /battlePlayerRenderStateKey/);
  assert.match(battleBlock, /battleSubmissionMarkup\(\)/);
  assert.match(battleBlock, /\["battle_review", "battle_vote", "battle_result"\]/);
  assert.doesNotMatch(battleBlock, /sessionStorage\.getItem\([^\n]*submission/i);
});
