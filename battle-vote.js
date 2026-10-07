// Prompt Battle voting and result, phone side (issue #31).
//
// Pure logic and markup; app.js owns the network calls, the DOM and the
// listeners (the quiz-core.js / battle-player.js pattern).
//
// What a phone may know comes from public room state, which reaches every
// phone verbatim. The host broadcasts two objects, built here so their shape
// is the privacy contract (test/battle-privacy-contract.test.js):
//   battleVote   - during battle_vote: the current matchup's prompt and its
//                  viable entries as { entryId, assetId } only, in a
//                  creator-neutral order.
//   battleResult - during battle_result: the resolution, which by spec reveals
//                  creators and vote counts.
// Who made which image is never in battleVote. A phone recognises its own
// entry only by finding one of the matchup's images among its own variants.

const LETTERS = ["A", "B", "C", "D"];

// Host side (wired by #32). hostPayload is get_host_battle_state() /
// host_battle_state_payload(); entries are re-sorted by entry ID because the
// host payload orders entrants by player name, which would leak who is who.
export function publicBattleVote(hostPayload, matchupIndex) {
  const matchup = (hostPayload?.matchups || []).find((entry) => entry?.matchupIndex === matchupIndex);
  if (!matchup) return null;
  const entries = (matchup.entrants || [])
    .filter((entrant) => entrant?.viable === true && typeof entrant.entryId === "string" && typeof entrant.submittedAssetId === "string")
    .map((entrant) => ({ entryId: entrant.entryId, assetId: entrant.submittedAssetId }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId));
  // The current matchup's prompt is shown with its images (#33); only future
  // matchups' prompts are secret.
  return { matchupId: matchup.matchupId, matchupIndex, promptText: String(matchup.promptText || ""), entries };
}

// Host side (wired by #32). resolution is resolve_battle_matchup()'s result.
// Player IDs stay on the host; names are the creator reveal.
export function publicBattleResult(resolution) {
  if (!resolution?.matchupId) return null;
  return {
    matchupId: resolution.matchupId,
    matchupIndex: resolution.matchupIndex,
    outcome: resolution.outcome,
    promptText: String(resolution.promptText || ""),
    votesCast: Number(resolution.votesCast) || 0,
    entries: (resolution.entries || [])
      .filter((entry) => entry?.viable === true && typeof entry.assetId === "string")
      .map((entry) => ({ entryId: entry.entryId, assetId: entry.assetId, votes: Number(entry.votes) || 0, winner: entry.winner === true, playerName: String(entry.playerName || ""), logoKey: entry.logoKey || null }))
      .sort((a, b) => a.entryId.localeCompare(b.entryId)),
  };
}

// publicRoomState() runs whatever the host holds through these before it is
// broadcast, so a host-shaped object assigned by mistake still cannot carry
// a name, player ID or count into battle_vote. Only the listed
// fields survive.
export function sanitizePublicBattleVote(value) {
  if (!value || typeof value.matchupId !== "string" || !Number.isInteger(value.matchupIndex) || !Array.isArray(value.entries)) return null;
  return {
    matchupId: value.matchupId,
    matchupIndex: value.matchupIndex,
    promptText: typeof value.promptText === "string" ? value.promptText : "",
    entries: value.entries
      .filter((entry) => typeof entry?.entryId === "string" && typeof entry.assetId === "string")
      // Viability is decided by publicBattleVote(); anything that says it is
      // not viable is dropped here too, rather than trusted to the media rule.
      .filter((entry) => entry.viable !== false && !entry.vetoed && !entry.forfeited)
      .map((entry) => ({ entryId: entry.entryId, assetId: entry.assetId }))
      .sort((a, b) => a.entryId.localeCompare(b.entryId)),
  };
}

export function sanitizePublicBattleResult(value) {
  if (!value || typeof value.matchupId !== "string" || !Array.isArray(value.entries)) return null;
  return publicBattleResult({ ...value, entries: value.entries.map((entry) => ({ ...entry, viable: true })) });
}

// cast_battle_vote outcomes. A repeat vote means the first one counted.
export function classifyVoteError(error) {
  const message = String(error?.message || "");
  if (/already voted/i.test(message)) return { status: "confirmed", message: "" };
  if (/not open|not the current matchup/i.test(message)) return { status: "rejected", message: "Voting on this matchup has closed." };
  if (/cannot vote in their own matchup/i.test(message)) return { status: "rejected", message: "You are in this matchup, so you cannot vote on it." };
  if (/forfeited|vetoed|no submitted image|not a valid/i.test(message)) return { status: "rejected", message: "That image can no longer be voted for." };
  if (/left this room|credentials/i.test(message)) return { status: "rejected", message: "This phone is no longer in the room." };
  return { status: "retryable", message: "Your vote did not go through. Try again." };
}

// vote: { matchupId, entryId, status: idle|pending|confirmed|rejected|retryable, message }
export function battleVoteView({ phase, battleVote, battleResult, matchupIndex, ownAssetIds = new Set(), vote = null, expandedIndex = null }) {
  if (phase === "battle_review") return { kind: "review-wait" };
  if (phase === "battle_result") {
    if (!battleResult || battleResult.matchupIndex !== matchupIndex) return { kind: "result-wait" };
    const mine = battleResult.entries.find((entry) => ownAssetIds.has(entry.assetId));
    const votedFor = vote?.matchupId === battleResult.matchupId && vote.status === "confirmed" ? vote.entryId : "";
    return {
      kind: "result",
      outcome: battleResult.outcome,
      votesCast: battleResult.votesCast,
      entries: battleResult.entries.map((entry, index) => ({ ...entry, letter: LETTERS[index] || String(index + 1), votedFor: entry.entryId === votedFor, mine: entry === mine })),
      onStage: Boolean(mine),
      iWon: Boolean(mine?.winner),
    };
  }
  if (phase !== "battle_vote") return { kind: "none" };
  if (!battleVote || battleVote.matchupIndex !== matchupIndex) return { kind: "vote-wait" };
  if (battleVote.entries.some((entry) => ownAssetIds.has(entry.assetId))) return { kind: "on-stage" };
  if (!battleVote.entries.length) return { kind: "vote-wait" };
  const current = vote?.matchupId === battleVote.matchupId ? vote : { status: "idle", entryId: "", message: "" };
  return {
    kind: "vote",
    matchupId: battleVote.matchupId,
    status: current.status,
    message: current.message || "",
    chosenEntryId: current.entryId || "",
    canVote: current.status === "idle" || current.status === "retryable",
    expandedIndex: Number.isInteger(expandedIndex) && expandedIndex >= 0 && expandedIndex < battleVote.entries.length ? expandedIndex : null,
    entries: battleVote.entries.map((entry, index) => ({ entryId: entry.entryId, assetId: entry.assetId, letter: LETTERS[index] || String(index + 1) })),
  };
}

// Redraw only when something structural moved (mistakes.md #14, #15).
export function battleVoteRenderKey(view) {
  return JSON.stringify(view);
}

export function battleVoteMarkup(view, escapeHtml) {
  const wait = (text) => `<section class="player-question battle-vote"><p>${escapeHtml(text)}</p><div class="player-waiting-pulse" aria-hidden="true"><i></i><i></i><i></i></div></section>`;
  if (view.kind === "review-wait") return wait("The host is checking the entries. Voting starts in a moment.");
  if (view.kind === "vote-wait") return wait("Get ready: the next matchup is on its way.");
  if (view.kind === "result-wait") return wait("Counting the votes…");
  if (view.kind === "on-stage") return `<section class="player-question battle-vote battle-vote--stage"><p class="battle-vote-stage-mark" aria-hidden="true">★</p><p class="battle-vote-lede">You are on stage!</p><p>Everyone else is voting on your matchup right now. Look up at the big screen.</p></section>`;

  if (view.kind === "vote") {
    const statusLine = {
      idle: "",
      pending: `<p class="battle-vote-status" role="status">Sending your vote…</p>`,
      confirmed: `<p class="battle-vote-status battle-vote-status--confirmed" role="status">Vote counted. Watch the big screen for the result.</p>`,
      rejected: `<p class="battle-vote-status battle-vote-status--rejected" role="alert">${escapeHtml(view.message)}</p>`,
      retryable: `<p class="battle-vote-status battle-vote-status--rejected" role="alert">${escapeHtml(view.message)}</p>`,
    }[view.status] || "";
    // The image expands; the button under it votes. Tapping a picture never
    // casts a vote by accident.
    const tiles = view.entries.map((entry, index) => {
      const chosen = entry.entryId === view.chosenEntryId && view.status !== "retryable";
      return `<div class="battle-vote-option${chosen ? " is-chosen" : ""}"><button type="button" class="battle-expand" data-battle-expand="${index}" aria-label="See image ${entry.letter} full screen"><img data-battle-vote-image="${escapeHtml(entry.assetId)}" alt="" /><span class="battle-vote-letter">${entry.letter}</span><span class="battle-expand-hint" aria-hidden="true">⤢</span></button><button type="button" class="battle-vote-button" data-battle-vote="${escapeHtml(entry.entryId)}" ${view.canVote ? "" : "disabled"} aria-pressed="${chosen ? "true" : "false"}">${chosen ? "✓ Your vote" : `Vote for ${entry.letter}`}</button></div>`;
    }).join("");
    const prompt = view.canVote ? "Tap an image to see it full screen, then vote." : view.status === "pending" ? "Sending…" : "Thanks for voting.";
    const lightbox = Number.isInteger(view.expandedIndex) && view.entries[view.expandedIndex]
      ? battleLightboxMarkup({
        images: view.entries.map((entry) => ({ assetId: entry.assetId, label: `Image ${entry.letter}` })),
        index: view.expandedIndex,
        action: { attr: "data-battle-vote", value: view.entries[view.expandedIndex].entryId, label: view.entries[view.expandedIndex].entryId === view.chosenEntryId && view.status !== "retryable" ? "✓ Your vote" : `Vote for ${view.entries[view.expandedIndex].letter}`, disabled: !view.canVote },
      }, escapeHtml)
      : "";
    return `<section class="player-question battle-vote"><p class="battle-vote-lede">${prompt}</p><div class="battle-vote-grid battle-vote-grid--${view.entries.length}">${tiles}</div>${statusLine}</section>${lightbox}`;
  }

  if (view.kind === "result") {
    if (view.outcome === "skipped") return `<section class="player-question battle-vote"><p class="battle-vote-lede">This matchup was skipped.</p><p>No entry could be shown, so no points were awarded.</p></section>`;
    const lede = view.onStage ? (view.iWon ? "You won this matchup!" : "Nice try! The room went the other way.") : "The results are in.";
    const rows = view.entries.map((entry) => `<li class="battle-result-row${entry.winner ? " is-winner" : ""}"><img data-battle-vote-image="${escapeHtml(entry.assetId)}" alt="" /><div><strong>${escapeHtml(entry.playerName)}${entry.mine ? " (you)" : ""}</strong><span>${entry.votes} ${entry.votes === 1 ? "vote" : "votes"}${entry.winner ? " · Winner" : ""}${entry.votedFor ? " · Your vote" : ""}</span></div></li>`).join("");
    return `<section class="player-question battle-vote"><p class="battle-vote-lede">${lede}</p><ol class="battle-result-list">${rows}</ol></section>`;
  }
  return "";
}

// Full-screen viewer shared by the ballot and the generation grid. One image
// at a time, previous / next, close, and the surface's own action (vote or
// favourite) so a player can decide while looking at the big version.
// images: [{ assetId, label }]; action: { attr, value, label, disabled }.
export function battleLightboxMarkup({ images, index, action }, escapeHtml) {
  const image = images[index];
  if (!image) return "";
  const step = (delta, label, symbol) => `<button type="button" class="battle-lightbox-step" data-battle-lightbox-step="${delta}" aria-label="${label}" ${index + delta < 0 || index + delta >= images.length ? "disabled" : ""}>${symbol}</button>`;
  const actionButton = action ? `<button type="button" class="btn battle-lightbox-action" ${action.attr}="${escapeHtml(action.value)}" ${action.disabled ? "disabled" : ""}>${escapeHtml(action.label)}</button>` : "";
  return `<div class="battle-lightbox" role="dialog" aria-modal="true" aria-label="${escapeHtml(image.label)}, full screen" data-battle-lightbox><button type="button" class="battle-lightbox-close" data-battle-lightbox-close aria-label="Close full screen">✕</button><div class="battle-lightbox-frame"><img data-battle-lightbox-image="${escapeHtml(image.assetId)}" alt="${escapeHtml(image.label)}" /></div><div class="battle-lightbox-bar">${images.length > 1 ? step(-1, "Previous image", "‹") : ""}<span class="battle-lightbox-label">${escapeHtml(image.label)}${images.length > 1 ? ` · ${index + 1} of ${images.length}` : ""}</span>${images.length > 1 ? step(1, "Next image", "›") : ""}</div>${actionButton}</div>`;
}
