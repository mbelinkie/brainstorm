import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  branchName, budgetAllowsNext, decideAcceptance, headMatchesReviewed, isPastDeadline, parseDeepseekBalance,
  prBodyAutoCloses, renderPrBody, renderSolPrompt, renderWorkerPrompt, resumeDecision, routeIssue,
  selectEligibleIssues, sessionSpendUsd, sortIssues, validateBalance, verifyInvalidated, worktreeName,
} from "../tools/batch-core.mjs";

const root = new URL("../", import.meta.url);
const config = JSON.parse(fs.readFileSync(new URL("docs/roadmap/config.json", root), "utf8"));

const issue = (number, overrides = {}) => ({
  number, title: `PB ${number}`, state: "OPEN", status: "Ready", acceptance: "Automated",
  priority: "P1", labels: ["model:standard", "effort:high"], liveClaim: null, kind: "implementation", ...overrides,
});

// ---- routing --------------------------------------------------------------

test("routeIssue maps a label set to the provider model id and effective effort", () => {
  const standard = routeIssue(["model:standard", "effort:medium"], config.routing);
  assert.equal(standard.modelId, "deepseek-v4-pro");
  assert.equal(standard.effectiveEffort, "high");
  assert.deepEqual(standard.problems, []);

  const economy = routeIssue(["model:economy", "effort:low"], config.routing);
  assert.equal(economy.modelId, "deepseek-flash");
  assert.equal(economy.effectiveEffort, "low");

  assert.equal(routeIssue(["model:advanced", "effort:low"], config.routing).modelId, null);
  assert.equal(routeIssue(["model:advanced", "effort:low"], config.routing).problems.length > 0, true);
});

// ---- selection ------------------------------------------------------------

test("selectEligibleIssues keeps in-scope implementation work and sorts by priority then number", () => {
  const issues = [
    issue(10, { title: "Goal", kind: "goal" }),
    issue(13, { priority: "P2" }),
    issue(14, { priority: "P0" }),
    issue(15, { state: "CLOSED" }),
    issue(16, { status: "Done" }),
    issue(17, { liveClaim: "someone" }),
    issue(18, { acceptance: "Producer", status: "In review" }),
    issue(19, { acceptance: "External" }),
    issue(20, { priority: "P0" }),
    issue(44, { priority: "P3" }),
    issue(45, { priority: "P0" }), // out of default scope
  ];
  const selected = selectEligibleIssues(issues);
  assert.deepEqual(selected.map((i) => i.number), [14, 20, 13, 44]);
  // an explicit real-environment authorization admits the External ticket
  const withAuth = selectEligibleIssues(issues, { externalAuthorized: new Set([19]) });
  assert.ok(withAuth.some((i) => i.number === 19));
});

test("sortIssues orders P0 before P3 and unknowns last, then by number", () => {
  const sorted = sortIssues([issue(2, { priority: null }), issue(1, { priority: "P3" }), issue(0, { priority: "P0" }), issue(3, { priority: "P0" })]);
  assert.deepEqual(sorted.map((i) => i.number), [0, 3, 1, 2]);
});

// ---- limits ---------------------------------------------------------------

test("validateBalance accepts only a non-negative USD total", () => {
  assert.equal(validateBalance({ currency: "USD", total: 5 }).ok, true);
  assert.equal(validateBalance({ currency: "usd", total: 0 }).ok, true);
  assert.equal(validateBalance({ currency: "CNY", total: 5 }).ok, false);
  assert.equal(validateBalance({ currency: "USD", total: -1 }).ok, false);
  assert.equal(validateBalance({ currency: "USD", total: NaN }).ok, false);
  assert.equal(validateBalance(null).ok, false);
});

test("parseDeepseekBalance reads balance_infos and sessionSpendUsd treats an increase as suspicious", () => {
  const before = parseDeepseekBalance({ balance_infos: [{ currency: "USD", total_balance: "10.00" }] });
  assert.deepEqual(before, { currency: "USD", total: 10 });
  assert.equal(parseDeepseekBalance({ balance_infos: [] }), null);

  const down = sessionSpendUsd({ currency: "USD", total: 10 }, { currency: "USD", total: 9.4 });
  assert.equal(down.increase, false);
  assert.ok(Math.abs(down.spend - 0.6) < 1e-9);
  const up = sessionSpendUsd({ currency: "USD", total: 10 }, { currency: "USD", total: 11 });
  assert.equal(up.increase, true);
});

test("budgetAllowsNext permits the last session to exceed the budget but not an earlier one", () => {
  assert.equal(budgetAllowsNext({ spentUsd: 5, budgetUsd: 10, isLastTicket: false }), true);
  assert.equal(budgetAllowsNext({ spentUsd: 10, budgetUsd: 10, isLastTicket: false }), false);
  assert.equal(budgetAllowsNext({ spentUsd: 10, budgetUsd: 10, isLastTicket: true }), true);
});

test("isPastDeadline stops the batch after the deadline", () => {
  const start = 1_000_000;
  assert.equal(isPastDeadline({ startMs: start, deadlineMs: 8 * 60 * 60 * 1000, nowMs: start + 1 }), false);
  assert.equal(isPastDeadline({ startMs: start, deadlineMs: 8 * 60 * 60 * 1000, nowMs: start + 8 * 60 * 60 * 1000 + 1 }), true);
});

// ---- branch/head review ---------------------------------------------------

test("headMatchesReviewed and verifyInvalidated compare commits on their short id", () => {
  const sha = "cd15757cd7ffa0adadb91325a9613d99c9975f2d";
  assert.equal(headMatchesReviewed("cd15757cd7ffa0adadb91325a9613d99c9975f2d", "cd15757"), true);
  assert.equal(headMatchesReviewed("a".repeat(40), sha), false);
  assert.equal(verifyInvalidated("b".repeat(40), sha), true);
  assert.equal(verifyInvalidated(sha, sha), false);
  assert.equal(verifyInvalidated(null, sha), false);
});

// ---- acceptance gating ----------------------------------------------------

test("decideAcceptance completes only accepted Automated work and never merges Producer/External", () => {
  assert.equal(decideAcceptance({ acceptance: "Automated", independentVerify: true, ownerAcceptance: false }), "complete");
  assert.equal(decideAcceptance({ acceptance: "Automated", independentVerify: false, ownerAcceptance: true }), "complete");
  assert.equal(decideAcceptance({ acceptance: "Automated", independentVerify: false, ownerAcceptance: false }), "wait");
  assert.equal(decideAcceptance({ acceptance: "Producer", independentVerify: true, ownerAcceptance: false }), "wait");
  assert.equal(decideAcceptance({ acceptance: "External", independentVerify: false, ownerAcceptance: false }), "skip");
});

// ---- PR body --------------------------------------------------------------

test("renderPrBody references the issue without any auto-closing keyword", () => {
  const body = renderPrBody({ number: 13, title: "PB 13", commit: "cd15757", branch: "codex/pb-13-1" });
  assert.ok(body.includes("#13"));
  assert.equal(prBodyAutoCloses(body), false);
  assert.equal(prBodyAutoCloses("Closes #13"), true);
  assert.equal(prBodyAutoCloses("fixes #13 and resolves #14"), true);
});

test("worker and Sol prompts carry the contract and boundaries but never a key", () => {
  const contract = "## Outcome\nDo the thing.\n";
  const worker = renderWorkerPrompt({ number: 13, title: "PB 13", body: contract, branch: "codex/pb-13-1", worktree: "../quiz-pb-13-1", startCommit: "abc1234", modelId: "deepseek-v4-pro", effectiveEffort: "high" });
  assert.ok(worker.includes(contract));
  assert.ok(worker.includes("Permanent authorization boundaries"));
  assert.ok(worker.includes("codex/pb-13-1"));
  assert.ok(!/sk-[A-Za-z0-9]/.test(worker));

  const sol = renderSolPrompt({ number: 13, reviewedSha: "cd15757", branch: "codex/pb-13-1" });
  assert.ok(sol.includes("cd15757"));
  assert.ok(sol.includes("read-only"));
});

// ---- interruption reconciliation ------------------------------------------

test("resumeDecision never duplicates a claim, PR or completion", () => {
  assert.deepEqual(resumeDecision({ persisted: null, live: { status: "Ready", liveClaimExecutionId: null } }), { action: "fresh" });
  assert.equal(resumeDecision({ persisted: null, live: { status: "Done" } }).action, "skip-completed");
  assert.equal(resumeDecision({ persisted: null, live: { completeRecorded: true, status: "In review" } }).action, "skip-completed");
  const mine = { executionId: "a", phase: "claimed" };
  assert.equal(resumeDecision({ persisted: mine, live: { status: "In progress", liveClaimExecutionId: "b" } }).action, "skip-held");
  assert.deepEqual(resumeDecision({ persisted: mine, live: { status: "In progress", liveClaimExecutionId: "a" } }), { action: "resume", phase: "claimed" });
  assert.deepEqual(resumeDecision({ persisted: { executionId: "a", phase: "worked" }, live: { status: "In review", liveClaimExecutionId: "a", prNumber: 7 } }), { action: "adopt-pr", prNumber: 7 });
});

test("branch and worktree names are isolated per issue and run", () => {
  assert.equal(branchName(13, 2), "codex/pb-13-2");
  assert.equal(worktreeName(13, 2), "../quiz-pb-13-2");
});
