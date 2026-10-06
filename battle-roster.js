// Prompt Battle host roster helpers (issue #27).
//
// Pure, client-safe derivations from the existing private
// get_host_battle_state payload (supabase/migrations/0041). The browser never
// recomputes billing: attemptsUsed, sessionSpendUsd and maxSessionSpendUsd are
// the server-reported values. Only publicBattleProgress() may be projected into
// shared state; every other helper stays host-only.

export const BATTLE_ROSTER_STATUS = {
  SUBMITTED: "Submitted",
  GENERATING: "Generating",
  READY_TO_SUBMIT: "Ready to submit",
  NOT_STARTED: "Not started",
  READY_TO_RETRY: "Ready to retry"
};

function generationHasAsset(generation) {
  return generation?.status === "complete" && Array.isArray(generation.assetIds) && generation.assetIds.filter(Boolean).length > 0;
}

function generationIsPending(generation) {
  return generation?.status === "pending";
}

function generationFailed(generation) {
  return generation?.status === "failed" || generation?.status === "blocked";
}

export function battleEntrantStatus(entrant = {}) {
  if (entrant.submitted) return BATTLE_ROSTER_STATUS.SUBMITTED;
  const generations = Array.isArray(entrant.generations) ? entrant.generations : [];
  // Precedence fixed by the issue: Submitted, then Generating, then a complete
  // asset ready to submit, then Not started, then Ready to retry.
  if (generations.some(generationIsPending)) return BATTLE_ROSTER_STATUS.GENERATING;
  if (generations.some(generationHasAsset)) return BATTLE_ROSTER_STATUS.READY_TO_SUBMIT;
  if (!generations.length && !(Number(entrant.attemptsUsed) > 0)) return BATTLE_ROSTER_STATUS.NOT_STARTED;
  // A refunded attempt is attemptsUsed 0 with a recorded failed generation, so
  // it must read Ready to retry rather than Not started.
  return BATTLE_ROSTER_STATUS.READY_TO_RETRY;
}

export function battleRosterEntrants(battleState) {
  const matchups = Array.isArray(battleState?.matchups) ? battleState.matchups : [];
  const entrants = [];
  for (const matchup of matchups) {
    const list = Array.isArray(matchup?.entrants) ? matchup.entrants : [];
    for (const entrant of list) entrants.push(entrant);
  }
  return entrants;
}

export function battleRosterCounts(battleState) {
  const entrants = battleRosterEntrants(battleState);
  return {
    total: entrants.length,
    submitted: entrants.filter((entrant) => battleEntrantStatus(entrant) === BATTLE_ROSTER_STATUS.SUBMITTED).length
  };
}

export function publicBattleProgress(battleState) {
  if (!battleState || !Array.isArray(battleState.matchups)) return null;
  const counts = battleRosterCounts(battleState);
  return { submitted: counts.submitted, total: counts.total };
}

export function battleSpendView(battleState = {}) {
  const capValue = battleState.maxSessionSpendUsd;
  const hasCap = capValue !== null && capValue !== undefined && capValue !== "" && Number.isFinite(Number(capValue));
  return {
    spend: Number(battleState.sessionSpendUsd) || 0,
    cap: hasCap ? Number(capValue) : null,
    capLabel: hasCap ? `$${Number(capValue).toFixed(2)} cap` : "No configured cap"
  };
}

export function battleRosterRows(battleState) {
  return battleRosterEntrants(battleState).map((entrant) => {
    const generations = Array.isArray(entrant.generations) ? entrant.generations : [];
    const attemptsUsed = Number(entrant.attemptsUsed) || 0;
    const refunded = attemptsUsed === 0 && generations.some(generationFailed);
    return {
      entryId: entrant.entryId,
      playerId: entrant.playerId,
      playerName: entrant.playerName || "Player",
      status: battleEntrantStatus(entrant),
      attemptsUsed,
      refunded,
      readyAsset: generations.some(generationHasAsset)
    };
  });
}
