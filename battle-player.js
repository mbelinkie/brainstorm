// Prompt Battle player screen (issue #23): prompt, Generate, variant grid.
//
// Pure logic and markup only; app.js owns the network calls, the DOM and the
// listeners. Kept out of app.js so tests can import it (the quiz-core.js
// pattern) and assert behaviour rather than match app.js source text.
//
// Two rules shape everything here:
//   * Never imply success before the server confirms it (mistakes.md #4).
//     A Generate reply only says "something was recorded". The grid is drawn
//     from get_player_battle_state() alone, re-read after every reply, so an
//     image appears only once the database lists it under this player's own
//     entry.
//   * The player sees their own entry and nothing else: their prompt, their
//     attempts and their own generations. No opponent, no pairing, no other
//     matchup and nothing about voting is read or rendered.

export const BATTLE_PROMPT_MAX_CHARS = 2048;
const UNCONFIRMED_MESSAGE = "Image generation failed. Refresh to check your attempt.";

// entry: undefined = not loaded yet, null = no entry this round (late join).
export function initialBattlePlayer(key = "") {
  return { key, loading: false, loadError: "", entry: undefined, draft: "", request: { status: "idle", message: "" }, favouriteAssetId: "" };
}

// One player-screen session per battle round. A new round starts clean.
export function battlePlayerKey(roomState) {
  return Number.isInteger(roomState?.battleRoundIndex) ? `round-${roomState.battleRoundIndex}` : "";
}

// Maps a /battle/generate reply (cloudflare-worker.js battleGenerateFlow) to
// what the player is told. httpStatus 0 means the request never got a reply.
export function classifyGenerateReply(httpStatus, body) {
  const serverMessage = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : "";
  if (httpStatus >= 200 && httpStatus < 300) {
    const assetIds = Array.isArray(body?.assetIds) ? body.assetIds.filter((id) => typeof id === "string" && id) : [];
    if (!assetIds.length) return { status: "unconfirmed", message: UNCONFIRMED_MESSAGE };
    return { status: "recorded", partial: body?.partial === true, assetIds };
  }
  // A safety refusal is refunded by the Worker before it answers 422.
  if (httpStatus === 422) return { status: "blocked", message: serverMessage || "That prompt was declined and did not use an attempt." };
  if (httpStatus === 400) return { status: "failed", message: serverMessage || "Check your prompt and try again." };
  // The authorizer refused before reserving anything: wrong phase, no entry,
  // no attempts left, or the room's spend cap. Nothing was charged.
  if (httpStatus >= 401 && httpStatus < 500) return { status: "refused", message: serverMessage || "You cannot generate an image right now." };
  return { status: "unconfirmed", message: serverMessage || UNCONFIRMED_MESSAGE };
}

// The request state after a Generate reply and the re-read that follows it.
// "Recorded" is only promoted to confirmed when every returned image is in
// the re-read entry; a reply the database does not back up is a failure the
// player can check, never a success.
export function settleGenerateRequest(reply, entryAfter) {
  if (reply.status !== "recorded") return { status: reply.status, message: reply.message };
  const listed = new Set(confirmedVariants(entryAfter).map((variant) => variant.assetId));
  if (!reply.assetIds.every((assetId) => listed.has(assetId))) return { status: "unconfirmed", message: UNCONFIRMED_MESSAGE };
  return { status: "confirmed", message: reply.partial ? "Only some of your images came back. That attempt still counted." : "" };
}

// Variants the server has recorded for this player, newest attempt first.
// Only complete generations count; a pending one has no images yet.
export function confirmedVariants(entry) {
  const generations = Array.isArray(entry?.generations) ? entry.generations : [];
  return generations
    .filter((generation) => generation?.status === "complete" && Array.isArray(generation.assetIds))
    .sort((a, b) => Number(b.attemptIndex) - Number(a.attemptIndex))
    .flatMap((generation) => generation.assetIds
      .filter((assetId) => typeof assetId === "string" && assetId)
      .map((assetId) => ({ assetId, attemptIndex: Number(generation.attemptIndex) })));
}

export function battlePlayerView(battle) {
  if (battle.loadError && battle.entry === undefined) return { kind: "load-error", message: battle.loadError };
  if (battle.entry === undefined) return { kind: "loading" };
  if (battle.entry === null) return { kind: "holding" };

  const entry = battle.entry;
  const attemptsRemaining = Number.isInteger(entry.attemptsRemaining) ? Math.max(entry.attemptsRemaining, 0) : 0;
  const variants = confirmedVariants(entry).map((variant) => ({ ...variant, favourite: variant.assetId === battle.favouriteAssetId }));
  const awaitingCheck = (entry.generations || []).some((generation) => generation?.status === "pending");
  const pending = battle.request.status === "pending";
  const draftLength = Array.from(battle.draft.trim()).length;
  const tooLong = draftLength > BATTLE_PROMPT_MAX_CHARS;

  let status = { kind: "idle", message: "" };
  if (pending) status = { kind: "pending", message: "Generating your images… this can take up to a minute." };
  else if (battle.request.status === "confirmed") status = { kind: "confirmed", message: battle.request.message || "New images are ready. Tap your favourite." };
  else if (["failed", "refused", "unconfirmed"].includes(battle.request.status)) status = { kind: "failed", message: battle.request.message };
  else if (battle.request.status === "blocked") status = { kind: "blocked", message: battle.request.message };
  if (!pending && attemptsRemaining === 0) {
    status = { kind: "over-budget", message: variants.length ? "You have used every attempt. Tap your favourite below." : "You have no attempts left this round." };
  }
  if (battle.loadError) status = { kind: "failed", message: battle.loadError };

  return {
    kind: "compose",
    promptText: String(entry.promptText || ""),
    attemptsRemaining,
    draft: battle.draft,
    tooLong,
    canGenerate: !pending && !battle.loading && attemptsRemaining > 0 && draftLength > 0 && !tooLong,
    pending,
    awaitingCheck,
    status,
    variants,
    favouriteAssetId: variants.some((variant) => variant.favourite) ? battle.favouriteAssetId : "",
  };
}

// The structural fields of the player battle screen. A redraw happens only
// when one of these changes; typing does not redraw (the draft is read from
// the textarea), so focus and caret survive (mistakes.md #14, #15).
export function battlePlayerRenderKey(view) {
  if (view.kind !== "compose") return JSON.stringify({ kind: view.kind, message: view.message || "" });
  return JSON.stringify({
    kind: view.kind,
    promptText: view.promptText,
    attemptsRemaining: view.attemptsRemaining,
    pending: view.pending,
    awaitingCheck: view.awaitingCheck,
    status: view.status,
    variants: view.variants.map((variant) => variant.assetId),
    favouriteAssetId: view.favouriteAssetId,
  });
}

const attemptsLabel = (count) => `${count} ${count === 1 ? "attempt" : "attempts"} left`;

// Inner markup of the player card's body. The caller supplies escapeHtml and
// wraps it in the round header. Images carry only an asset ID; app.js loads
// them through the /media proxy with the player token.
export function battlePlayerMarkup(view, escapeHtml) {
  if (view.kind === "loading") return `<section class="player-question battle-player"><p>Loading your prompt…</p><div class="player-waiting-pulse" aria-hidden="true"><i></i><i></i><i></i></div></section>`;
  if (view.kind === "load-error") return `<section class="player-question battle-player"><p class="battle-player-status battle-player-status--failed" role="alert">${escapeHtml(view.message)}</p><button class="btn btn-primary battle-player-retry" data-battle-reload>Try again</button></section>`;
  if (view.kind === "holding") return `<section class="player-question battle-player"><p>This battle started before you joined. Sit tight: you will vote on the matchups soon.</p><div class="player-waiting-pulse" aria-hidden="true"><i></i><i></i><i></i></div></section>`;

  const statusLine = view.status.kind === "idle"
    ? ""
    : `<p class="battle-player-status battle-player-status--${escapeHtml(view.status.kind)}" ${view.status.kind === "failed" || view.status.kind === "blocked" ? 'role="alert"' : 'role="status"'}>${escapeHtml(view.status.message)}</p>`;
  const checkNote = view.awaitingCheck && !view.pending ? `<p class="battle-player-note" role="status">One attempt is still being checked. Its images will appear here if it went through.</p>` : "";
  const generateLabel = view.pending ? "Generating…" : "Generate";
  const grid = view.variants.length
    ? `<div class="battle-variant-grid" role="list">${view.variants.map((variant, index) => `<button type="button" class="battle-variant${variant.favourite ? " is-favourite" : ""}" role="listitem" data-battle-favourite="${escapeHtml(variant.assetId)}" aria-pressed="${variant.favourite ? "true" : "false"}" aria-label="Image ${index + 1}${variant.favourite ? ", your favourite" : ""}"><img data-battle-variant-image="${escapeHtml(variant.assetId)}" alt="" /><span class="battle-variant-mark" aria-hidden="true">★</span></button>`).join("")}</div><p class="battle-player-note">Tap an image to mark your favourite.</p>`
    : "";
  return `<section class="player-question battle-player">
<div class="battle-player-prompt-card"><p class="eyebrow">Your prompt</p><p class="battle-player-prompt">${escapeHtml(view.promptText)}</p></div>
<label class="battle-player-label" for="battle-prompt-input">Describe your image</label>
<textarea id="battle-prompt-input" class="battle-player-input" data-battle-prompt-input rows="4" maxlength="${BATTLE_PROMPT_MAX_CHARS}" ${view.pending || view.attemptsRemaining === 0 ? "disabled" : ""} placeholder="A cat in a business suit giving a toast…">${escapeHtml(view.draft)}</textarea>
<div class="battle-player-actions"><button type="button" class="btn btn-primary" data-battle-generate ${view.canGenerate ? "" : "disabled"}>${generateLabel}</button><span class="battle-player-attempts" data-battle-attempts>${attemptsLabel(view.attemptsRemaining)}</span></div>
${statusLine}${checkNote}${grid}
</section>`;
}
