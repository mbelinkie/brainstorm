// Pure decision logic for the DeepSeek batch orchestrator (issue #51). No I/O,
// no child processes, no GitHub. codex-batch.mjs performs the side effects and
// reaches GitHub only through scripts/roadmap/gate.mjs.

import { effectiveEffort, evaluateRouting, sameCommit } from "../scripts/roadmap/lifecycle-core.mjs";

export const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const DEFAULT_BUDGET_USD = 10;
export const DEFAULT_BATCH_DEADLINE_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ATTEMPTS = 2;

// model IDs that close/fix/resolve an issue automatically. A PR body that
// references the issue must not use any of these before the #number.
const AUTO_CLOSE_WORDS = /\b(?:close|closes|closed|closing|fix|fixes|fixed|fixing|resolve|resolves|resolved|resolving)\s+#\d+\b/i;

export function branchName(issueNumber, run = 1) {
  return `codex/pb-${issueNumber}-${run}`;
}

export function worktreeName(issueNumber, run = 1) {
  return `../quiz-pb-${issueNumber}-${run}`;
}

// Resolve a label set to the exact provider model id and the runner's effective
// effort. Returns problems (as evaluateRouting does) instead of guessing.
export function routeIssue(labels, routing) {
  const routingResult = evaluateRouting(labels, routing);
  const profile = routingResult.profile && routing.profiles[routingResult.profile];
  return {
    profile: routingResult.profile,
    effort: routingResult.effort,
    modelId: profile ? profile.modelId : null,
    effectiveEffort: effectiveEffort(routingResult.effort, routing),
    problems: routingResult.problems,
  };
}

// ---- selection ------------------------------------------------------------

const priorityRank = (issue) => (Object.prototype.hasOwnProperty.call(PRIORITY_ORDER, issue.priority) ? PRIORITY_ORDER[issue.priority] : PRIORITY_ORDER.length);

export function sortIssues(issues) {
  return [...issues].sort((a, b) => priorityRank(a) - priorityRank(b) || Number(a.number) - Number(b.number));
}

// Default scope is the [PB] implementation issues. Goals, closed/Done work,
// live-claimed work, Producer tickets already awaiting review, and External
// tickets without explicit real-environment authorization are excluded.
export function selectEligibleIssues(issues, { minNumber = 13, maxNumber = 44, externalAuthorized = new Set() } = {}) {
  const eligible = [];
  for (const issue of issues) {
    const number = Number(issue.number);
    if (number < minNumber || number > maxNumber) continue;
    if (issue.kind === "goal") continue;
    if (issue.state === "CLOSED" || issue.status === "Done") continue;
    if (issue.liveClaim) continue;
    if (issue.acceptance === "Producer" && issue.status === "In review") continue;
    if (issue.acceptance === "External" && !externalAuthorized.has(number)) continue;
    eligible.push(issue);
  }
  return sortIssues(eligible);
}

// ---- limits: budget, deadline, attempts -----------------------------------

// Account-wide USD balance decrease is the conservative spend estimate. A
// missing, non-numeric, negative, non-USD or increased balance stops spending.
export function validateBalance(balance) {
  const currency = String(balance?.currency ?? "").trim().toUpperCase();
  const total = balance == null ? NaN : Number(balance.total);
  if (!currency || currency !== "USD") return { ok: false, reason: "balance is missing or not in USD" };
  if (!Number.isFinite(total) || total < 0) return { ok: false, reason: "balance total is missing, non-numeric or negative" };
  return { ok: true, currency, total };
}

export function sessionSpendUsd(before, after) {
  const b = validateBalance(before);
  const a = validateBalance(after);
  if (!b.ok || !a.ok) return null;
  if (a.total > b.total) return { increase: true, spend: 0, before: b.total, after: a.total };
  return { increase: false, spend: b.total - a.total, before: b.total, after: a.total };
}

// A session may exceed the budget only when it is the last ticket in the batch.
export function budgetAllowsNext({ spentUsd, budgetUsd = DEFAULT_BUDGET_USD, isLastTicket = false }) {
  if (spentUsd < budgetUsd) return true;
  return isLastTicket;
}

export function timeLeftMs({ startMs, deadlineMs = DEFAULT_BATCH_DEADLINE_MS, nowMs }) {
  return startMs + deadlineMs - nowMs;
}

export function isPastDeadline({ startMs, deadlineMs = DEFAULT_BATCH_DEADLINE_MS, nowMs }) {
  return timeLeftMs({ startMs, deadlineMs, nowMs }) <= 0;
}

export function attemptsUsed(state, issueNumber) {
  return Number(state?.issues?.[issueNumber]?.attempts ?? 0);
}

export function attemptsRemaining(state, issueNumber, maxAttempts = DEFAULT_ATTEMPTS) {
  return Math.max(0, maxAttempts - attemptsUsed(state, issueNumber));
}

// ---- branch/head review validation ----------------------------------------

export function headMatchesReviewed(remoteHeadSha, reviewedSha) {
  return sameCommit(remoteHeadSha, reviewedSha);
}

// A verify that names a different commit than the reviewed one does not accept
// the reviewed work.
export function verifyInvalidated(verifyCommit, reviewedCommit) {
  return Boolean(verifyCommit && reviewedCommit) && !sameCommit(verifyCommit, reviewedCommit);
}

// ---- acceptance gating ----------------------------------------------------

export function decideAcceptance({ acceptance, independentVerify, ownerAcceptance }) {
  if (acceptance === "Automated") {
    return independentVerify || ownerAcceptance ? "complete" : "wait";
  }
  if (acceptance === "Producer") return "wait";
  return "skip"; // External requires explicit authorization before it is selected
}

// ---- PR bodies ------------------------------------------------------------

export function renderPrBody({ number, title, commit, branch }) {
  return [
    `Implementation for issue #${number}`,
    "",
    `- Title: ${title}`,
    `- Branch: \`${branch}\``,
    `- Reviewed commit: \`${commit}\``,
    "",
    `See issue #${number}.`,
    "",
  ].join("\n");
}

export function prBodyAutoCloses(body) {
  return AUTO_CLOSE_WORDS.test(body ?? "");
}

// ---- interruption reconciliation ------------------------------------------

// Compare persisted run state with live observations and decide what to do so a
// resume never creates a duplicate claim, PR or completion. Age is never proof
// an execution stopped; a held claim or an existing PR is preserved.
export function resumeDecision({ persisted, live }) {
  if (live.completeRecorded || live.status === "Done") return { action: "skip-completed" };
  if (live.liveClaimExecutionId && (!persisted || live.liveClaimExecutionId !== persisted.executionId)) {
    return { action: "skip-held", heldBy: live.liveClaimExecutionId };
  }
  if (live.prNumber && persisted && !persisted.prNumber) return { action: "adopt-pr", prNumber: live.prNumber };
  if (!persisted) return { action: "fresh" };
  return { action: "resume", phase: persisted.phase ?? "claimed" };
}

// ---- DeepSeek balance -----------------------------------------------------

export function parseDeepseekBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  if (infos.length === 0) return null;
  const info = infos[0];
  return { currency: String(info?.currency ?? "").toUpperCase(), total: Number(info?.total_balance) };
}

// ---- worker / reviewer prompts --------------------------------------------

// Permanent authorization boundaries baked into every worker prompt. The key is
// never part of the prompt text: it is injected as an environment variable.
export const WORKER_BOUNDARIES = [
  "You own the claim, commits and review for this ticket using your own authentic Codex identity (claim/review with --execution-id set to this run's own CODEX_THREAD_ID).",
  "Stage explicit git paths only; never git add -A / git add .",
  "Work test-first with node:test; run `npm test` and report real output.",
  "Publish your branch and open a PR before asking for verification. The PR body must reference the issue number without any auto-closing keyword (no Closes/Fixes/Resolves #N).",
  "Never merge, close, complete, deploy, or choose a migration number. Stop at In review.",
  "Do not read, print or copy any credential, private key, or absolute local path into a commit, comment, PR or log.",
].join("\n");

export const SOL_BOUNDARIES = [
  "You are a read-only independent reviewer. You must not edit, commit, push, or otherwise change the repository.",
  "Verify that the branch's exact remote head equals the reviewed commit; a changed commit invalidates any prior verification.",
  "Record your verification using your own Codex identity (lifecycle.mjs verify with your own --execution-id).",
].join("\n");

export function renderWorkerPrompt({ number, title, body, branch, worktree, startCommit, modelId, effectiveEffort }) {
  return [
    `Work GitHub issue #${number} in mbelinkie/brainstorm on branch ${branch} (worktree ${worktree}), starting from commit ${startCommit}.`,
    `Model ${modelId} (effective effort ${effectiveEffort}).`,
    "",
    "## Issue contract",
    body,
    "",
    "## Permanent authorization boundaries",
    WORKER_BOUNDARIES,
    "",
  ].join("\n");
}

export function renderSolPrompt({ number, reviewedSha, branch }) {
  return [
    `Independently verify the work for GitHub issue #${number} on branch ${branch}.`,
    `Reviewed commit: ${reviewedSha}. Check the branch's exact remote head; if it differs, report the mismatch and do not verify.`,
    "",
    SOL_BOUNDARIES,
    "",
  ].join("\n");
}
