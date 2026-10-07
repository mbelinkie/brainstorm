export function firstViableBattleMatchupIndex(review) {
  const matchups = Array.isArray(review?.matchups) ? review.matchups : [];
  const index = matchups.findIndex((matchup) => Array.isArray(matchup?.viableEntryIds) && matchup.viableEntryIds.length > 0);
  if (index < 0) return null;
  return Number.isInteger(matchups[index].matchupIndex) ? matchups[index].matchupIndex : index;
}

function submittedPrompt(entry) {
  const assetId = entry?.submittedAssetId;
  if (!assetId) return "";
  const generation = (Array.isArray(entry.generations) ? entry.generations : [])
    .find((item) => Array.isArray(item?.assetIds) && item.assetIds.includes(assetId));
  return typeof generation?.playerPrompt === "string" ? generation.playerPrompt : "";
}

export function battleReviewMarkup(review, escapeHtml, { busy = false } = {}) {
  const matches = Array.isArray(review?.matchups) ? review.matchups : [];
  return `<section class="battle-review" aria-label="Battle review">${matches.map((matchup, arrayIndex) => {
    const index = Number.isInteger(matchup?.matchupIndex) ? matchup.matchupIndex : arrayIndex;
    const entries = (Array.isArray(matchup?.entrants) ? matchup.entrants : [])
      .filter((entry) => entry?.submitted === true || Boolean(entry?.submittedAssetId));
    const entryMarkup = entries.length ? entries.map((entry) => {
      const name = entry.playerName || "Player";
      const assetId = entry.submittedAssetId || "";
      const prompt = submittedPrompt(entry);
      const vetoed = entry.vetoed === true;
      const action = vetoed ? "undo" : "veto";
      const actionLabel = vetoed ? "Undo veto" : "Veto entry";
      const disabled = busy || !assetId;
      const image = assetId
        ? `<img data-battle-review-image="${escapeHtml(assetId)}" alt="${escapeHtml(`${name}'s submitted image`)}" loading="lazy">`
        : `<div class="battle-review-image-missing" role="img" aria-label="Submitted image unavailable">Image unavailable</div>`;
      return `<article class="battle-review-entry${vetoed ? " is-vetoed" : ""}"><div class="battle-review-image">${image}</div><div class="battle-review-entry-copy"><p class="battle-review-creator"><span>Created by</span> ${escapeHtml(name)}</p><p class="battle-review-player-prompt"><span>Player prompt</span>${prompt ? escapeHtml(prompt) : "Prompt unavailable"}</p>${vetoed ? `<p class="battle-review-veto-reason"><span>Vetoed</span>${escapeHtml(entry.vetoReason || "No reason supplied")}</p>` : ""}<button class="btn btn-secondary battle-review-action" type="button" data-battle-review-action="${action}" data-battle-entry-id="${escapeHtml(entry.entryId || "")}" ${disabled ? "disabled" : ""}>${busy ? "Saving…" : actionLabel}</button></div></article>`;
    }).join("") : `<p class="battle-round-note">No submitted entries.</p>`;
    const skipped = matchup?.skipped === true
      ? `<span class="battle-review-skipped" role="status">Skipped — no viable entries</span>`
      : "";
    return `<section class="battle-review-matchup" data-battle-matchup-index="${index}"><div class="battle-review-matchup-heading"><div><h4>Matchup ${index + 1}</h4><p>${escapeHtml(matchup?.promptText || "Prompt unavailable")}</p></div>${skipped}</div><div class="battle-review-grid">${entryMarkup}</div></section>`;
  }).join("")}</section>`;
}

// The veto RPC's payload is deliberately ignored. A separate host-state read
// is the source of truth after both a successful action and an uncertain reply.
export async function vetoBattleEntryAndRefresh({ api, refresh, roomCode, hostSecret, entryId, reason = "", veto = true }) {
  let result;
  let actionError;
  try {
    result = await api.vetoBattleEntry({ roomCode, hostSecret, entryId, reason, veto });
  } catch (error) {
    actionError = error;
  }

  try {
    await refresh();
  } catch (refreshError) {
    if (actionError) throw new AggregateError([actionError, refreshError], "The review action and refresh both failed.", { cause: actionError });
    throw refreshError;
  }
  if (actionError) throw actionError;
  return result;
}
