// Roadmap lifecycle wrapper, part 2 of 2 (issue #45): review, verify, complete,
// stale, release. createLifecycle (lifecycle.mjs) hands this module its shared
// internals, so every read and write still goes through the gate session.
//
// Same rules as part 1: refusals are returned, never thrown, and are decided
// before the first write. No write is replayed blindly: each operation re-reads,
// finds what the stable marker comments say already happened, and completes only
// what is missing. This module is the only place an issue is closed.

import {
  findIndependentVerification,
  findOwnerAcceptance,
  isCommit,
  latestRelease,
  markedComments,
  parseReviewComment,
  parseVerifyComment,
  renderCompleteComment,
  renderReleaseComment,
  renderReviewComment,
  renderVerifyComment,
  resolveExecutionId,
  sameCommit,
  staleReport,
  SESSION_ID_ENV,
} from "./lifecycle-core.mjs";

const CLOSE_ISSUE = `mutation LifecycleCloseIssue($id: ID!) {
  closeIssue(input: { issueId: $id, stateReason: COMPLETED }) { issue { id state } }
}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const text = (value) => (typeof value === "string" ? value.trim() : "");
const refuse = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function createFinish({ gate, config, env, now, thisRepo, trusted, evaluate, setStatus, addComment, commentThenStatus }) {
  const integrationBranch = config.repository.integrationBranch;
  const closeIssue = (ops, snap) => ops.mutate({ query: CLOSE_ISSUE, variables: { id: snap.issue.id } });

  // Refusals every operation shares once the live issue has been read.
  function usable(snap, number) {
    if (!snap.boardItem) return refuse("NOT_ON_BOARD", `#${number} is not an item on Project ${config.project.owner}/${config.project.number}`);
    if (!snap.claimHistoryComplete) return refuse("CLAIM_HISTORY_INCOMPLETE", "older comments were not fetched, so the records needed for this step may be on a page not seen");
    return null;
  }

  const latestReview = (snap, number) => {
    const last = markedComments(snap.comments, "review", number, { authors: trusted }).at(-1);
    return last ? { ...parseReviewComment(last.comment.body), index: last.index } : null;
  };

  const implementingIds = (snap, number) => {
    const ids = snap.claims.claims.map((c) => c.executionId).filter(Boolean);
    for (const { comment } of markedComments(snap.comments, "review", number)) {
      const id = parseReviewComment(comment.body).executionId;
      if (id) ids.push(id);
    }
    return ids;
  };

  // ---- review ------------------------------------------------------------

  async function review(number, opts = {}) {
    const commit = text(opts.commit);
    if (!isCommit(commit)) return refuse("COMMIT_INVALID", "the tested commit must be a 7 to 40 character hex id");
    const missing = ["commands", "exclusions", "outstanding"].filter((key) => !text(opts[key]));
    if (missing.length > 0) return refuse("REVIEW_FIELD_REQUIRED", `a review records ${missing.join(", ")}`, { missing });
    const id = resolveExecutionId({ flag: opts.executionId, env });
    if (!id.ok) return id;

    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number, { light: true });
      if (!snap.ok) return snap;
      if (snap.issue.state !== "OPEN") return refuse("ISSUE_CLOSED", `#${number} is closed`);
      const problem = usable(snap, number);
      if (problem) return problem;
      if (!["In progress", "In review"].includes(snap.status)) {
        return refuse("STATUS_NOT_REVIEWABLE", `review needs Status In progress (it is ${snap.status ?? "none"})`);
      }
      const live = snap.claims.live;
      if (!live || live.executionId !== id.executionId) {
        return refuse("NO_OWN_CLAIM", "only the execution holding the live claim can record its work for review", { heldBy: live?.executionId ?? null });
      }
      if (!snap.acceptanceClass) return refuse("ACCEPTANCE_CLASS", "the issue's acceptance class cannot be read");
      if (snap.acceptanceClass === "External" && !text(opts.externalEvidence)) {
        return refuse("EXTERNAL_EVIDENCE_REQUIRED", "an External issue needs real-environment evidence (--external-evidence)");
      }

      const already = markedComments(snap.comments, "review", number, { authors: trusted })
        .some(({ comment, index }) => index > live.index && sameCommit(parseReviewComment(comment.body).commit, commit));
      if (already) {
        if (snap.status === "In review") return { ok: true, op: "review", alreadyInReview: true, status: "In review" };
        const written = await setStatus(ops, snap, "In review");
        if (!written.ok) return { ...written, step: "status" };
        return { ok: true, op: "review", reconciled: true, status: "In review" };
      }
      const body = renderReviewComment({
        number, acceptanceClass: snap.acceptanceClass, executionId: id.executionId, commit, branch: text(opts.branch),
        commands: opts.commands, artifacts: opts.artifacts, exclusions: opts.exclusions, outstanding: opts.outstanding,
        externalEvidence: text(opts.externalEvidence), nowIso: new Date(now()).toISOString(),
      });
      if (snap.status === "In review") {
        // Rework of a new commit: a fresh record, same status.
        const posted = await addComment(ops, snap, body);
        if (!posted.ok) return { ...posted, nextStep: "re-run review; it re-reads before writing" };
        return { ok: true, op: "review", status: "In review", commentUrl: posted.data?.addComment?.commentEdge?.node?.url ?? null };
      }
      const written = await commentThenStatus(ops, snap, { body, statusName: "In review", opName: "review" });
      if (!written.ok) return written;
      return { ok: true, op: "review", status: "In review", commentUrl: written.commentUrl };
    });
  }

  // ---- verify ------------------------------------------------------------

  async function verify(number, opts = {}) {
    const commit = text(opts.commit);
    if (!isCommit(commit)) return refuse("COMMIT_INVALID", "the verified commit must be a 7 to 40 character hex id");
    if (!text(opts.checks)) return refuse("REVIEW_FIELD_REQUIRED", "a verification records the checks that were re-run and their results", { missing: ["checks"] });
    const id = resolveExecutionId({ flag: opts.executionId, env });
    if (!id.ok) return id;

    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number, { light: true });
      if (!snap.ok) return snap;
      if (snap.issue.state !== "OPEN") return refuse("ISSUE_CLOSED", `#${number} is closed`);
      const problem = usable(snap, number);
      if (problem) return problem;
      const reviewed = latestReview(snap, number);
      if (!reviewed?.commit) return refuse("NO_REVIEW_RECORD", "there is no review record to verify");
      if (!sameCommit(reviewed.commit, commit)) {
        return refuse("VERIFY_COMMIT_MISMATCH", `the review records ${reviewed.commit}, not ${commit}; verification must be of the exact reviewed commit`);
      }
      if (implementingIds(snap, number).includes(id.executionId)) {
        return refuse("VERIFIER_NOT_INDEPENDENT", "this execution implemented or reviewed the work; its own run is a self-report, not verification");
      }
      const already = markedComments(snap.comments, "verify", number, { authors: trusted }).some(({ comment, index }) => {
        const parsed = parseVerifyComment(comment.body);
        return index > reviewed.index && parsed.verifier === id.executionId && sameCommit(parsed.commit, commit);
      });
      if (already) return { ok: true, op: "verify", alreadyVerified: true };
      const posted = await addComment(ops, snap, renderVerifyComment({ number, commit, executionId: id.executionId, checks: opts.checks, nowIso: new Date(now()).toISOString() }));
      if (!posted.ok) return { ...posted, nextStep: "re-run verify; it re-reads before writing" };
      return { ok: true, op: "verify", verified: true, commentUrl: posted.data?.addComment?.commentEdge?.node?.url ?? null };
    });
  }

  // ---- complete ----------------------------------------------------------

  // Is the tested commit on the integration baseline (or a special branch the
  // issue itself records)? GitHub's compare API answers: the commit is reachable
  // from the base when the status is identical or behind.
  async function reachable(ops, snap, commit, specialBranch) {
    const base = specialBranch || integrationBranch;
    if (specialBranch && (!BRANCH_NAME.test(specialBranch) || !snap.startingBaseline.includes(specialBranch))) {
      return refuse("SPECIAL_BRANCH_NOT_RECORDED", `${specialBranch} is not named in this issue's Starting baseline section; record it there first so dependants do not branch from a baseline missing this work`);
    }
    const path = `/repos/${thisRepo}/compare/${base.split("/").map(encodeURIComponent).join("/")}...${commit}`;
    const result = await ops.rest({ method: "GET", path });
    if (!result.ok) {
      if (result.code === "HTTP_ERROR" && [404, 422].includes(result.status)) {
        return refuse("COMMIT_NOT_PUSHED", `GitHub does not know commit ${commit}; push it before completing`);
      }
      return result;
    }
    if (["identical", "behind"].includes(result.data?.status)) return { ok: true, base };
    return refuse("COMMIT_NOT_ON_BASELINE", `commit ${commit} is not reachable from ${base} (compare says ${result.data?.status ?? "unknown"}); merge and push it first`);
  }

  // Re-read after writing: success is only claimed for what GitHub now shows.
  async function confirmDone(ops, number) {
    const again = await evaluate(ops, number, { light: true });
    if (!again.ok) return again;
    if (again.issue.state !== "CLOSED" || again.status !== "Done") {
      return refuse("VERIFY_FAILED", `the re-read shows state ${again.issue.state} and Status ${again.status ?? "none"}, not closed and Done; nothing is assumed, re-run complete to reconcile`);
    }
    return { ok: true };
  }

  // The status/close half, shared by a fresh completion and a reconciliation.
  async function statusAndClose(ops, snap, { commentPosted }) {
    let statusSet = snap.status === "Done";
    if (!statusSet) {
      const written = await setStatus(ops, snap, "Done");
      if (!written.ok) {
        return refuse("PARTIAL_WRITE", `the completion comment is on record but the Done write failed (${written.code}); re-run to finish without a second comment`, {
          commentPosted, statusSet: false, closed: snap.issue.state === "CLOSED", cause: written.code, nextStep: "re-run complete",
        });
      }
      statusSet = true;
    }
    if (snap.issue.state !== "CLOSED") {
      const closed = await closeIssue(ops, snap);
      if (!closed.ok) {
        return refuse("PARTIAL_WRITE", `Status is Done but closing the issue failed (${closed.code}); re-run to close it`, {
          commentPosted, statusSet, closed: false, cause: closed.code, nextStep: "re-run complete",
        });
      }
    }
    return { ok: true };
  }

  async function complete(number, opts = {}) {
    const specialBranch = text(opts.specialBranch);
    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number, { light: true });
      if (!snap.ok) return snap;
      const problem = usable(snap, number);
      if (problem) return problem;
      if (!snap.acceptanceClass) return refuse("ACCEPTANCE_CLASS", "the issue's acceptance class cannot be read");

      // A completion comment already on record means acceptance was verified
      // then; finish only the missing half and re-read.
      const recorded = markedComments(snap.comments, "complete", number, { authors: trusted }).length > 0;
      if (recorded) {
        if (snap.issue.state === "CLOSED" && snap.status === "Done") return { ok: true, op: "complete", alreadyCompleted: true };
        const written = await statusAndClose(ops, snap, { commentPosted: true });
        if (!written.ok) return written;
        const confirmed = await confirmDone(ops, number);
        if (!confirmed.ok) return confirmed;
        return { ok: true, op: "complete", completed: true, reconciled: true, verified: true };
      }

      if (snap.status !== "In review") {
        return refuse("STATUS_NOT_IN_REVIEW", `complete needs Status In review (it is ${snap.status ?? "none"}); record the work with review first`);
      }
      const reviewed = latestReview(snap, number);
      if (!reviewed?.commit) return refuse("NO_REVIEW_RECORD", "there is no review record; the work was never recorded for acceptance");

      const cls = snap.acceptanceClass;
      let how;
      if (cls === "Producer") {
        if (!findOwnerAcceptance(snap.comments, reviewed.index, reviewed.commit, trusted)) {
          return refuse("ACCEPTANCE_MISSING", `Producer acceptance needs the owner's explicit acceptance naming commit ${reviewed.commit.slice(0, 7)}, posted after the review`, { acceptanceClass: cls });
        }
        how = "the repository owner accepted this exact commit in a comment after the review";
      } else if (cls === "Automated") {
        const byOwner = findOwnerAcceptance(snap.comments, reviewed.index, reviewed.commit, trusted);
        const byVerifier = findIndependentVerification(snap.comments, number, reviewed.index, reviewed.commit, implementingIds(snap, number), trusted);
        if (!byOwner && !byVerifier) {
          return refuse("ACCEPTANCE_MISSING", "Automated acceptance needs a verify:v1 record from an execution other than the implementer, or the owner's acceptance, for the reviewed commit; the implementer's own review is a self-report", { acceptanceClass: cls });
        }
        how = byVerifier ? "retained check results re-run by an independent execution (verify:v1)" : "the repository owner accepted the retained check results";
      } else {
        if (!reviewed.externalEvidence) {
          return refuse("EXTERNAL_EVIDENCE_REQUIRED", "the review records no real-environment evidence", { acceptanceClass: cls });
        }
        how = "real-environment evidence recorded in the review";
      }

      const where = await reachable(ops, snap, reviewed.commit, specialBranch);
      if (!where.ok) return where;

      const body = renderCompleteComment({ number, acceptanceClass: cls, commit: reviewed.commit, baseline: where.base, how, nowIso: new Date(now()).toISOString() });
      const posted = await addComment(ops, snap, body);
      if (!posted.ok) return { ...posted, step: "comment", nextStep: "re-run complete; it re-reads before writing" };
      const written = await statusAndClose(ops, snap, { commentPosted: true });
      if (!written.ok) return written;
      const confirmed = await confirmDone(ops, number);
      if (!confirmed.ok) return confirmed;
      return { ok: true, op: "complete", completed: true, verified: true, commentUrl: posted.data?.addComment?.commentEdge?.node?.url ?? null };
    });
  }

  // ---- stale / release ---------------------------------------------------

  async function stale(number) {
    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number, { light: true });
      if (!snap.ok) return snap;
      const completed = markedComments(snap.comments, "complete", number, { authors: trusted }).length > 0;
      const report = staleReport({ issueState: snap.issue.state, status: snap.status, claims: snap.claims, completed, nowMs: now() });
      if (!snap.claimHistoryComplete) report.discrepancies.push({ code: "CLAIM_HISTORY_INCOMPLETE", message: "older comments were not fetched; claim records may be incomplete" });
      return { ok: true, op: "stale", issue: snap.issue, status: snap.status, claimHistoryComplete: snap.claimHistoryComplete, ...report };
    });
  }

  async function release(number, opts = {}) {
    if (!text(opts.evidence) || !text(opts.confirmedBy)) {
      return refuse("RELEASE_EVIDENCE_REQUIRED", "restarting a claim needs the operator's name (--confirmed-by) and the evidence the execution stopped (--evidence); age alone is never proof");
    }
    const stopped = text(opts.stoppedExecution).toLowerCase();
    if (!UUID.test(stopped)) return refuse("EXECUTION_ID_INVALID", "--stopped-execution must be the stopped run's UUID");
    if (stopped === String(env[SESSION_ID_ENV] ?? "").trim().toLowerCase()) {
      return refuse("SELF_RELEASE", "this run is evidently still running; it cannot release its own claim as stopped");
    }

    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number, { light: true });
      if (!snap.ok) return snap;
      if (snap.issue.state !== "OPEN") return refuse("ISSUE_CLOSED", `#${number} is closed`);
      const problem = usable(snap, number);
      if (problem) return problem;

      const live = snap.claims.live;
      if (!live) {
        const released = latestRelease(snap.comments, number, trusted);
        const lastClaim = snap.claims.claims.at(-1)?.index ?? -1;
        if (released && released.stopped === stopped && released.index > lastClaim) {
          if (snap.status === "Ready") return { ok: true, op: "release", alreadyReleased: true, status: "Ready" };
          const written = await setStatus(ops, snap, "Ready");
          if (!written.ok) return { ...written, step: "status" };
          return { ok: true, op: "release", reconciled: true, status: "Ready" };
        }
        return refuse("NO_LIVE_CLAIM", `#${number} has no live claim to release`);
      }
      if (live.executionId !== stopped) {
        return refuse("CLAIM_MISMATCH", `the live claim belongs to ${live.executionId ?? "an execution whose id cannot be read"}, not ${stopped}`, { heldBy: live.executionId });
      }
      if (!["In progress", "In review", "Blocked", "Ready"].includes(snap.status)) {
        return refuse("STATUS_NOT_RELEASABLE", `Status ${snap.status ?? "none"} cannot be returned to Ready`);
      }
      const body = renderReleaseComment({ number, stoppedExecution: stopped, confirmedBy: opts.confirmedBy, evidence: opts.evidence, nowIso: new Date(now()).toISOString() });
      const written = await commentThenStatus(ops, snap, { body, statusName: "Ready", opName: "release" });
      if (!written.ok) return written;
      return { ok: true, op: "release", released: true, status: "Ready", commentUrl: written.commentUrl };
    });
  }

  return { review, verify, complete, stale, release };
}
