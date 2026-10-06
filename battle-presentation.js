// Prompt Battle on the big screen (issue #33): the current matchup side by
// side during battle_vote, then vote bars and the creator reveal during
// battle_result.
//
// A strict projection of broadcast state. Everything here is computed from
// state.battleVote / state.battleResult (built and whitelisted by
// battle-vote.js); nothing is read from the host's own panels and no result
// is computed here: counts and winners come from resolve_battle_matchup().
// Images exist only in battle_vote and battle_result.

const LETTERS = ["A", "B", "C", "D"];

export function presentationBattleScene({ phase, battleVote, battleResult, matchupIndex, matchupCount }) {
  const position = Number.isInteger(matchupIndex) && Number(matchupCount) > 0 ? { number: matchupIndex + 1, count: Number(matchupCount) } : null;
  if (phase === "battle_review") return { kind: "review", position: null };
  if (phase === "battle_vote") {
    if (!battleVote || battleVote.matchupIndex !== matchupIndex || !battleVote.entries?.length) return { kind: "vote-wait", position };
    return {
      kind: "vote",
      position,
      promptText: String(battleVote.promptText || ""),
      entries: battleVote.entries.map((entry, index) => ({ assetId: entry.assetId, letter: LETTERS[index] || String(index + 1) })),
    };
  }
  if (phase === "battle_result") {
    if (!battleResult || battleResult.matchupIndex !== matchupIndex) return { kind: "result-wait", position };
    if (battleResult.outcome === "skipped" || !battleResult.entries?.length) return { kind: "skipped", position };
    const total = Number(battleResult.votesCast) || 0;
    return {
      kind: "result",
      position,
      outcome: battleResult.outcome,
      promptText: String(battleResult.promptText || ""),
      votesCast: total,
      entries: battleResult.entries.map((entry, index) => ({
        assetId: entry.assetId,
        letter: LETTERS[index] || String(index + 1),
        playerName: String(entry.playerName || ""),
        logoKey: entry.logoKey || null,
        votes: Number(entry.votes) || 0,
        winner: entry.winner === true,
        // Share of the votes cast, for the bar. Zero votes cast: no bar.
        share: total > 0 ? Math.round((Number(entry.votes) || 0) / total * 100) : 0,
      })),
    };
  }
  return { kind: "none", position: null };
}

// logo(entry) renders a player's logo (app.js playerLogoMarkup); injected so
// this module stays importable under node.
export function presentationBattleMarkup(scene, escapeHtml, { roundTitle = "Prompt Battle", logo = () => "" } = {}) {
  const eyebrow = `Prompt Battle${scene.position ? ` · Matchup ${scene.position.number} of ${scene.position.count}` : ""}`;
  const card = (modifier, body) => `<section class="presentation-card presentation-card--battle presentation-card--battle-${modifier}" aria-live="polite"><p class="eyebrow">${escapeHtml(eyebrow)}</p>${body}</section>`;
  if (scene.kind === "review") return card("review", `<h2>${escapeHtml(roundTitle)}</h2><p class="presentation-battle-note">The judges are checking the entries. Voting starts in a moment.</p>`);
  if (scene.kind === "vote-wait") return card("wait", `<h2>Next matchup</h2><p class="presentation-battle-note">Get your phones ready to vote.</p>`);
  if (scene.kind === "result-wait") return card("wait", `<h2>Counting the votes…</h2>`);
  if (scene.kind === "skipped") return card("wait", `<h2>Matchup skipped</h2><p class="presentation-battle-note">No entry could be shown, so no points this time.</p>`);
  const prompt = scene.promptText ? `<h2 class="presentation-battle-prompt">${escapeHtml(scene.promptText)}</h2>` : "";

  if (scene.kind === "vote") {
    // The stage starts hidden and is revealed by app.js only once every image
    // has loaded, so the room never sees one picture arrive before the other.
    const tiles = scene.entries.map((entry) => `<figure class="presentation-battle-tile"><div class="presentation-battle-frame"><img data-battle-stage-image="${escapeHtml(entry.assetId)}" alt="Image ${entry.letter}" /></div><figcaption><span class="presentation-battle-letter">${entry.letter}</span></figcaption></figure>`).join("");
    return card("vote", `${prompt}<div class="presentation-battle-stage presentation-battle-stage--${scene.entries.length}" data-battle-stage aria-busy="true">${tiles}<p class="presentation-battle-loading" aria-hidden="true">Get ready…</p></div><p class="presentation-battle-cta">Vote on your phone</p>`);
  }

  if (scene.kind === "result") {
    const heading = scene.outcome === "tie" ? "It's a tie!" : scene.outcome === "default" ? "Winner by default" : "The winner is…";
    const tiles = scene.entries.map((entry) => `<figure class="presentation-battle-tile${entry.winner ? " is-winner" : ""}"><div class="presentation-battle-frame"><img data-battle-stage-image="${escapeHtml(entry.assetId)}" alt="Image ${entry.letter} by ${escapeHtml(entry.playerName)}" />${entry.winner ? '<span class="presentation-battle-crown" aria-hidden="true">★</span>' : ""}</div><figcaption><span class="presentation-battle-letter">${entry.letter}</span><span class="presentation-battle-creator">${logo(entry)}<strong>${escapeHtml(entry.playerName)}</strong></span><span class="presentation-battle-bar" aria-hidden="true"><i style="--share:${entry.share}%"></i></span><span class="presentation-battle-votes">${entry.votes} ${entry.votes === 1 ? "vote" : "votes"}</span></figcaption></figure>`).join("");
    return card("result", `<h2 class="presentation-battle-result-heading">${heading}</h2>${prompt ? prompt.replace("<h2 ", '<p ').replace("</h2>", "</p>") : ""}<div class="presentation-battle-stage presentation-battle-stage--${scene.entries.length}" data-battle-stage aria-busy="true">${tiles}<p class="presentation-battle-loading" aria-hidden="true">Get ready…</p></div>`);
  }
  return "";
}
