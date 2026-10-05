// Measurement and tuning (DELEGATION.md section 10). Pure: the caller supplies
// ticket states, reopen records and audit results; this returns statistics and
// recommendations. Nothing here changes configuration by itself.

const LANE_ORDER = ["express", "standard", "protected"];

// Sol audit sample: every pilot accept, then 1 in earlyRate until earlyUntil, then 1 in steadyRate.
export function shouldAudit(acceptedCount, { pilotAll = 10, earlyRate = 5, earlyUntil = 30, steadyRate = 20 } = {}) {
  if (!Number.isInteger(acceptedCount) || acceptedCount < 1) return false;
  if (acceptedCount <= pilotAll) return true;
  if (acceptedCount <= earlyUntil) return acceptedCount % earlyRate === 0;
  return acceptedCount % steadyRate === 0;
}

// Apply owner-set category overrides to a triage decision.
export function applyCategoryOverrides(lane, category, overrides = {}) {
  const o = overrides[category] ?? {};
  if (!o.minLane) return lane;
  return LANE_ORDER.indexOf(o.minLane) > LANE_ORDER.indexOf(lane) ? o.minLane : lane;
}

export function ladderStartFor(category, overrides = {}) {
  const v = overrides[category]?.ladderStart;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

// tickets: ticket state objects; reopens: { [n]: { reopened: bool } }; audits: { [n]: { defect: bool } }
export function buildReport({ tickets, reopens = {}, audits = {}, thresholds = { express: 0.1, standard: 0.05 } }) {
  const finished = tickets.filter((t) => t.phase === "finished" || t.phase === "awaiting-owner");
  const byCategory = new Map();
  for (const t of finished) {
    const key = `${t.category ?? "uncategorized"}|${t.lane ?? "?"}`;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(t);
  }
  const categories = [];
  const recommendations = [];
  for (const [key, list] of byCategory) {
    const [category, lane] = key.split("|");
    list.sort((a, b) => String(a.finishedAt ?? "").localeCompare(String(b.finishedAt ?? "")));
    const last10 = list.slice(-10);
    const reopened10 = last10.filter((t) => reopens[t.n]?.reopened).length;
    const reopenRate = last10.length ? reopened10 / last10.length : 0;
    const firstAttempts = list.map((t) => firstAttemptOf(t)).filter(Boolean);
    const flashFirst = firstAttempts.filter((a) => a.model === "deepseek-flash");
    const flashPass = flashFirst.length ? flashFirst.filter((a) => a.result === "GREEN").length / flashFirst.length : null;
    const credits = list.map((t) => (t.codexSessions ?? []).reduce((s, x) => s + (x.credits ?? 0), 0));
    const usd = list.map((t) => t.deepseek?.usdEstimate ?? 0);
    const auditDefects = list.filter((t) => audits[t.n]?.defect).length;
    const row = {
      category, lane, tickets: list.length, reopenedLast10: reopened10, reopenRateLast10: round(reopenRate),
      flashFirstPassRate: flashPass === null ? null : round(flashPass), avgCodexCredits: round(avg(credits)), avgDeepseekUsd: round(avg(usd), 4), auditDefects,
    };
    categories.push(row);
    const limit = thresholds[lane];
    if (limit !== undefined && last10.length >= 10 && reopenRate > limit) {
      const next = LANE_ORDER[LANE_ORDER.indexOf(lane) + 1];
      if (next) recommendations.push(`Promote "${category}" from ${lane} to ${next}: ${reopened10}/10 reopened (limit ${limit * 100}%). Set categoryOverrides["${category}"].minLane = "${next}".`);
    }
    if (list.length >= 20 && list.slice(-20).every((t) => !reopens[t.n]?.reopened) && lane !== "express") {
      recommendations.push(`Consider demoting "${category}" from ${lane}: no reopens in the last 20 tickets.`);
    }
    if (flashFirst.length >= 5 && flashPass < 0.3) {
      recommendations.push(`Start "${category}" at the Pro rung: Flash passed first time in ${Math.round(flashPass * 100)}% of ${flashFirst.length}. Set categoryOverrides["${category}"].ladderStart = 2.`);
    }
    if (auditDefects > 0) recommendations.push(`"${category}" (${lane}): Sol audits found ${auditDefects} defect(s) Luna accepted; tighten triggers or route this category to Sol review.`);
  }
  const quotes = finished.filter((t) => t.recon?.total).map((t) => t.recon.verified / t.recon.total);
  if (quotes.length >= 5 && avg(quotes) < 0.9) recommendations.push(`Recon quote verification averages ${Math.round(avg(quotes) * 100)}%: set deepseek.scout.model to "deepseek-v4-pro".`);

  const budgets = {};
  const sessions = finished.flatMap((t) => t.codexSessions ?? []).filter((s) => s.usage);
  for (const role of [...new Set(sessions.map((s) => s.role))]) {
    const list = sessions.filter((s) => s.role === role);
    budgets[role] = { sessions: list.length, p80Input: percentile(list.map((s) => s.usage.input), 80), p80Output: percentile(list.map((s) => s.usage.output), 80) };
    if (finished.length >= 20 && list.length >= 10) {
      recommendations.push(`Budget for ${role}: about { "input": ${Math.ceil(budgets[role].p80Input * 1.5)}, "output": ${Math.ceil(budgets[role].p80Output * 1.5)} } (1.5x the 80th percentile).`);
    }
  }
  const totals = {
    finished: finished.length,
    reopened: finished.filter((t) => reopens[t.n]?.reopened).length,
    codexCredits: round(finished.reduce((s, t) => s + (t.codexSessions ?? []).reduce((a, x) => a + (x.credits ?? 0), 0), 0)),
    deepseekUsd: round(finished.reduce((s, t) => s + (t.deepseek?.usdEstimate ?? 0), 0), 4),
  };
  const kept = totals.finished - totals.reopened;
  totals.creditsPerKeptTicket = kept > 0 ? round(totals.codexCredits / kept) : null;
  return { totals, categories, budgets, recommendations };
}

function firstAttemptOf(t) {
  const all = [...(t.doneSlices ?? []).flatMap((s) => s.attempts ?? []), ...(t.attempts ?? [])];
  return all.find((a) => a.attempt === 1) ?? all[0] ?? null;
}
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function formatReport(r) {
  const lines = [
    `Kept tickets: ${r.totals.finished - r.totals.reopened}/${r.totals.finished} (reopened ${r.totals.reopened}); Codex credits ${r.totals.codexCredits} (${r.totals.creditsPerKeptTicket ?? "n/a"} per kept ticket); DeepSeek ~$${r.totals.deepseekUsd}`,
    "",
    "category | lane | tickets | reopened (last 10) | Flash first-pass | credits/ticket | DeepSeek $/ticket | audit defects",
    ...r.categories.map((c) => `${c.category} | ${c.lane} | ${c.tickets} | ${c.reopenedLast10} (${Math.round(c.reopenRateLast10 * 100)}%) | ${c.flashFirstPassRate === null ? "n/a" : `${Math.round(c.flashFirstPassRate * 100)}%`} | ${c.avgCodexCredits} | ${c.avgDeepseekUsd} | ${c.auditDefects}`),
    "",
    "Recommendations:",
    ...(r.recommendations.length ? r.recommendations.map((x) => `- ${x}`) : ["- none yet"]),
  ];
  return lines.join("\n");
}
