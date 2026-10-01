// Pure decision logic for the DeepSeek batch orchestrator (issue #51). No I/O,
// no child processes, no GitHub. codex-batch.mjs performs the side effects and
// reaches GitHub only through scripts/roadmap/gate.mjs.

import { effectiveEffort, evaluateRouting, sameCommit, splitSections } from "../scripts/roadmap/lifecycle-core.mjs";

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
// missing, null, empty, non-numeric, negative, non-USD or increased balance
// stops spending. A null/empty total must never coerce to zero.
export function validateBalance(balance) {
  const currency = String(balance?.currency ?? "").trim().toUpperCase();
  const raw = balance == null ? undefined : balance.total;
  const total = (raw === null || raw === undefined || raw === "") ? NaN : Number(raw);
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

// A new coding session launches only while cumulative spend is strictly below
// budget. The already-started session may push spend past the budget, but no
// further launch happens once spentUsd >= budgetUsd.
export function budgetAllowsNext({ spentUsd, budgetUsd = DEFAULT_BUDGET_USD }) {
  return spentUsd < budgetUsd;
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

// ---- migration-number allocation ------------------------------------------

// A ticket that declares a migration must already carry the number Matthew
// assigned; the dispatcher never guesses one. Returns null when the contract
// declares no migration, and an object with `allocated` otherwise.
export function migrationAllocation(body) {
  const text = (splitSections(body ?? "")["Migrations"] ?? "").trim();
  if (!text || /^none$/i.test(text)) return null;
  const number = /\d+/.exec(text)?.[0] ?? null;
  return { allocated: Boolean(number), number: number ? Number(number) : null };
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
  const raw = info?.total_balance;
  const total = (raw === null || raw === undefined || raw === "") ? NaN : Number(raw);
  return { currency: String(info?.currency ?? "").toUpperCase(), total };
}

// ---- worker / reviewer prompts --------------------------------------------

// Permanent authorization boundaries baked into every worker prompt. The key is
// never part of the prompt text: it is injected as an environment variable.
export const WORKER_BOUNDARIES = [
  "You own the claim, commits and review for this ticket using your own authentic Codex identity (claim/review with --execution-id set to this run's own CODEX_THREAD_ID).",
  "Stage explicit git paths only; never git add -A / git add .",
  "Work test-first with node:test; run `npm test` and report real output.",
  "Commit, then record `lifecycle.mjs review` with your own id and the real commands, and STOP at In review.",
  "Never publish, push, merge, close, complete, deploy, or choose a migration number; the dispatcher publishes and the owner completes.",
  "Do not read, print or copy any credential, private key, or absolute local path into a commit, comment, PR or log.",
  "Attribute the work to DeepSeek; never attribute work to Claude that you did not run through Claude.",
  "After two evidence-based failed attempts without progress, stop and ask.",
].join("\n");

export const SOL_BOUNDARIES = [
  "You are a read-only independent reviewer. You must not edit, commit, push, or otherwise change the repository.",
  "In this verifier worktree, check out the exact reviewed commit and confirm the branch's remote head equals it; a changed commit invalidates any prior verification.",
  "Run the required checks (`npm ci` then `npm test`) and report their real output; CLI exit zero alone is not acceptance.",
  "Record your verification using your own Codex identity (lifecycle.mjs verify with your own --execution-id, the exact reviewed commit, and the checks you re-ran).",
].join("\n");

export function renderWorkerPrompt({ number, title, body, branch, worktree, startCommit, modelId, profile, logicalEffort, effectiveEffort, claimCommand, rework }) {
  return [
    `Work GitHub issue #${number} in mbelinkie/brainstorm on branch ${branch} (worktree ${worktree}), starting from the verified commit ${startCommit}.`,
    `Model ${modelId} (model:${profile}), logical effort ${logicalEffort}, effective effort ${effectiveEffort}.`,
    "",
    "## Issue contract",
    body,
    "",
    "## Authorized claim",
    claimCommand || "(the dispatcher did not provide an exact claim command; derive it from docs/roadmap/WORKING_A_TICKET.md)",
    "",
    ...(rework ? ["## Reviewer findings to address", rework, ""] : []),
    "## Permanent authorization boundaries",
    WORKER_BOUNDARIES,
    "",
  ].join("\n");
}

export function renderSolPrompt({ number, reviewedSha, branch, verifyCommand }) {
  return [
    `Independently verify the work for GitHub issue #${number} on branch ${branch}.`,
    `Reviewed commit: ${reviewedSha}. Check the branch's exact remote head; if it differs, report the mismatch and do not verify.`,
    "",
    "## Authorized verification",
    verifyCommand || "(the dispatcher did not provide an exact verify command; derive it from docs/roadmap/WORKING_A_TICKET.md)",
    "",
    SOL_BOUNDARIES,
    "",
  ].join("\n");
}
