import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  COMMIT, OTHER, SELF, STATUS_OPTIONS, VERIFIER, acceptComment, claimComment, completeComment, config, contractBody,
  makeWorld, reviewComment, reviewedWorld, root, setup, verifyComment,
} from "./helpers/roadmap-world.js";
import { findOwnerAcceptance, parseClaims, sameCommit } from "../scripts/roadmap/lifecycle-core.mjs";

// Lifecycle wrapper part 2 (issue #45): review, verify, complete, stale, release.
// Fake GitHub only. Every refusal also asserts that no write was sent.

const noWrites = (transport) => assert.deepEqual(transport.mutationNames(), [], "a write was sent before/despite the refusal");
const reviewOpts = (extra = {}) => ({
  executionId: SELF, commit: COMMIT, commands: "npm test: 497 tests, 497 pass", artifacts: "none", exclusions: "no deploy",
  outstanding: "owner replies accepted", ...extra,
});
const inProgressWorld = (acceptance = "Automated", extra = {}) => {
  const world = makeWorld(extra);
  world.issues[3].body = contractBody({ acceptance });
  world.issues[3].items[0].acceptance = acceptance;
  world.issues[3].comments = [claimComment(SELF)];
  return world;
};
const statusOf = (world) => world.issues[3].items[0].status;

// ---- review ---------------------------------------------------------------

test("full commit IDs compare exactly while legacy abbreviated records remain readable", () => {
  const other = `${COMMIT.slice(0, 7)}${"f".repeat(33)}`;
  assert.equal(sameCommit(COMMIT, COMMIT), true);
  assert.equal(sameCommit(COMMIT, other), false);
  assert.equal(sameCommit(COMMIT, COMMIT.slice(0, 7)), true);
  assert.equal(sameCommit(COMMIT.slice(0, 12), COMMIT), true);
  assert.equal(findOwnerAcceptance([{ author: { login: "mbelinkie" }, body: `accepted ${other}` }], -1, COMMIT, ["mbelinkie"]), false);
  assert.equal(findOwnerAcceptance([{ author: { login: "mbelinkie" }, body: `accepted ${COMMIT.slice(0, 7)}` }], -1, COMMIT, ["mbelinkie"]), true);
});

test("review records the tested commit, commands, exclusions and outstanding steps, then sets In review", async () => {
  const world = inProgressWorld();
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.review(3, reviewOpts({ artifacts: "scripts/roadmap/lifecycle.mjs sha256:abc", branch: "claude/x" }));
  assert.equal(result.ok, true);
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"]);
  const body = world.issues[3].comments.at(-1).body;
  assert.ok(body.startsWith("<!-- review:v1 issue=3 -->\n"));
  for (const needle of [COMMIT, "npm test: 497 tests", "sha256:abc", "no deploy", "owner replies accepted", SELF, "Automated"]) assert.ok(body.includes(needle), needle);
  assert.equal(statusOf(world), "In review");
  assert.equal(transport.mutations()[1].variables.option, STATUS_OPTIONS["In review"]);
});

test("review refuses missing facts and a missing execution ID before any request", async () => {
  const cases = [
    [{ commit: "zzz" }, "COMMIT_INVALID"], [{ commit: undefined }, "COMMIT_INVALID"],
    [{ commands: "" }, "REVIEW_FIELD_REQUIRED"], [{ exclusions: " " }, "REVIEW_FIELD_REQUIRED"], [{ outstanding: undefined }, "REVIEW_FIELD_REQUIRED"],
    [{ executionId: undefined }, "EXECUTION_ID_MISSING"], [{ executionId: OTHER }, "EXECUTION_ID_CONFLICT"],
  ];
  for (const [extra, code] of cases) {
    const { lifecycle, transport } = setup({ world: inProgressWorld() });
    const result = await lifecycle.review(3, reviewOpts(extra));
    assert.equal(result.code, code);
    assert.equal(transport.calls.length, 0, code);
  }
});

test("review refuses unless this execution holds the live claim and the status is In progress", async () => {
  const other = inProgressWorld();
  other.issues[3].comments = [claimComment(OTHER)];
  let r = setup({ world: other });
  assert.equal((await r.lifecycle.review(3, reviewOpts())).code, "NO_OWN_CLAIM");
  noWrites(r.transport);
  const none = inProgressWorld();
  none.issues[3].comments = [];
  r = setup({ world: none });
  assert.equal((await r.lifecycle.review(3, reviewOpts())).code, "NO_OWN_CLAIM");
  noWrites(r.transport);
  for (const status of ["Ready", "Backlog", "Done", "Blocked"]) {
    const world = inProgressWorld();
    world.issues[3].items[0].status = status;
    r = setup({ world });
    assert.equal((await r.lifecycle.review(3, reviewOpts())).code, "STATUS_NOT_REVIEWABLE", status);
    noWrites(r.transport);
  }
});

test("an External issue cannot go to review without real-environment evidence", async () => {
  const world = inProgressWorld("External");
  let r = setup({ world });
  assert.equal((await r.lifecycle.review(3, reviewOpts())).code, "EXTERNAL_EVIDENCE_REQUIRED");
  noWrites(r.transport);
  r = setup({ world });
  const ok = await r.lifecycle.review(3, reviewOpts({ externalEvidence: "live run on two SETUP TEST issues, transcript in comment" }));
  assert.equal(ok.ok, true);
  assert.match(world.issues[3].comments.at(-1).body, /External evidence: live run on two SETUP TEST/);
});

test("review partial write: comment posted, status failed; the re-run sets only the status, then is a no-op", async () => {
  const world = inProgressWorld("Automated", { statusFailures: [502] });
  const first = setup({ world });
  const partial = await first.lifecycle.review(3, reviewOpts());
  assert.equal(partial.code, "PARTIAL_WRITE");
  assert.equal(partial.commentPosted, true);
  const second = setup({ world });
  assert.equal((await second.lifecycle.review(3, reviewOpts())).ok, true);
  assert.deepEqual(second.transport.mutationNames(), ["LifecycleSetStatus"]);
  const third = setup({ world });
  const again = await third.lifecycle.review(3, reviewOpts());
  assert.equal(again.alreadyInReview, true);
  noWrites(third.transport);
  assert.equal(world.issues[3].comments.filter((c) => c.body.startsWith("<!-- review:v1")).length, 1);
});

test("a rework review of a new commit adds a comment without touching the status", async () => {
  const world = reviewedWorld();
  const { lifecycle, transport } = setup({ world });
  const newer = "a".repeat(40);
  const result = await lifecycle.review(3, reviewOpts({ commit: newer }));
  assert.equal(result.ok, true);
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment"]);
  assert.equal(world.issues[3].comments.filter((c) => c.body.startsWith("<!-- review:v1")).length, 2);
});

// ---- verify ---------------------------------------------------------------

test("verify records an independent check and refuses the implementing execution itself", async () => {
  const world = reviewedWorld();
  const own = setup({ world });
  const refused = await own.lifecycle.verify(3, { executionId: SELF, commit: COMMIT, checks: "npm test pass" });
  assert.equal(refused.code, "VERIFIER_NOT_INDEPENDENT");
  noWrites(own.transport);

  const independent = setup({ world, env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  const ok = await independent.lifecycle.verify(3, { executionId: VERIFIER, commit: COMMIT, checks: "npm test: 497 pass on a fresh checkout" });
  assert.equal(ok.ok, true);
  assert.deepEqual(independent.transport.mutationNames(), ["LifecycleAddComment"]);
  assert.match(world.issues[3].comments.at(-1).body, /^<!-- verify:v1 issue=3 -->/);
});

test("verify refuses a commit that is not the reviewed one, missing checks, and a missing review", async () => {
  const mismatch = setup({ world: reviewedWorld(), env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  assert.equal((await mismatch.lifecycle.verify(3, { executionId: VERIFIER, commit: "b".repeat(40), checks: "x" })).code, "VERIFY_COMMIT_MISMATCH");
  noWrites(mismatch.transport);
  const noChecks = setup({ world: reviewedWorld(), env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  assert.equal((await noChecks.lifecycle.verify(3, { executionId: VERIFIER, commit: COMMIT, checks: "" })).code, "REVIEW_FIELD_REQUIRED");
  assert.equal(noChecks.transport.calls.length, 0);
  const noReview = setup({ world: inProgressWorld(), env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  assert.equal((await noReview.lifecycle.verify(3, { executionId: VERIFIER, commit: COMMIT, checks: "x" })).code, "NO_REVIEW_RECORD");
  noWrites(noReview.transport);
});

test("verify is idempotent: the same verifier and commit does not post twice", async () => {
  const world = reviewedWorld({ comments: [verifyComment()] });
  const { lifecycle, transport } = setup({ world, env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  const result = await lifecycle.verify(3, { executionId: VERIFIER, commit: COMMIT, checks: "again" });
  assert.equal(result.alreadyVerified, true);
  noWrites(transport);
});

// ---- complete: acceptance per class --------------------------------------

async function completeRefused(world, code, opts) {
  const r = setup({ world });
  const result = await r.lifecycle.complete(3, opts);
  assert.equal(result.ok, false, `expected ${code}`);
  assert.equal(result.code, code);
  noWrites(r.transport);
  assert.equal(statusOf(world), "In review");
  assert.equal(world.issues[3].state, "OPEN");
  return result;
}

test("complete (Producer) needs the owner's explicit acceptance of the exact commit, after the review", async () => {
  await completeRefused(reviewedWorld({ acceptance: "Producer" }), "ACCEPTANCE_MISSING");
  await completeRefused(reviewedWorld({ acceptance: "Producer", comments: [acceptComment("accepted")] }), "ACCEPTANCE_MISSING"); // no commit named
  await completeRefused(reviewedWorld({ acceptance: "Producer", comments: [acceptComment(`not accepted ${COMMIT.slice(0, 7)}`)] }), "ACCEPTANCE_MISSING");
  await completeRefused(reviewedWorld({ acceptance: "Producer", comments: [acceptComment(`accepted ${"f".repeat(7)}`)] }), "ACCEPTANCE_MISSING"); // another version
  const before = reviewedWorld({ acceptance: "Producer" });
  before.issues[3].comments.splice(1, 0, acceptComment(undefined, { id: "C_early" })); // acceptance older than the review
  await completeRefused(before, "ACCEPTANCE_MISSING");
  // a stranger's acceptance and a wrapper-marked comment do not count
  await completeRefused(reviewedWorld({ acceptance: "Producer", comments: [acceptComment(undefined, { author: { login: "stranger" } })] }), "ACCEPTANCE_MISSING");
  await completeRefused(reviewedWorld({ acceptance: "Producer", comments: [acceptComment(`<!-- block:v1 issue=3 -->\naccepted ${COMMIT.slice(0, 7)}`)] }), "ACCEPTANCE_MISSING");
});

test("complete (Automated) refuses a bare self-report and the implementer verifying itself", async () => {
  await completeRefused(reviewedWorld({ acceptance: "Automated" }), "ACCEPTANCE_MISSING");
  await completeRefused(reviewedWorld({ acceptance: "Automated", comments: [verifyComment(SELF)] }), "ACCEPTANCE_MISSING");
  await completeRefused(reviewedWorld({ acceptance: "Automated", comments: [verifyComment(VERIFIER, "b".repeat(40))] }), "ACCEPTANCE_MISSING");
  await completeRefused(reviewedWorld({ acceptance: "Automated", comments: [verifyComment(VERIFIER, COMMIT, { author: { login: "stranger" } })] }), "ACCEPTANCE_MISSING");
});

test("complete (External) refuses a review with no real-environment evidence", async () => {
  await completeRefused(reviewedWorld({ acceptance: "External" }), "EXTERNAL_EVIDENCE_REQUIRED");
});

async function completes(world, opts) {
  const r = setup({ world });
  const result = await r.lifecycle.complete(3, opts);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...r, result };
}

test("complete writes the marked comment, Done and the close, then verifies by re-reading", async () => {
  const cases = [
    reviewedWorld({ acceptance: "Producer", comments: [acceptComment()] }),
    reviewedWorld({ acceptance: "Automated", comments: [verifyComment()] }),
    reviewedWorld({ acceptance: "Automated", comments: [acceptComment()] }),
  ];
  const external = reviewedWorld({ acceptance: "External" });
  external.issues[3].comments[1] = reviewComment(COMMIT, { body: `${reviewComment().body}- External evidence: live run transcript\n` });
  cases.push(external);
  for (const world of cases) {
    const { transport, result, lockCalls } = await completes(world);
    assert.equal(result.completed, true);
    assert.equal(result.verified, true);
    assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus", "LifecycleCloseIssue"]);
    assert.equal(statusOf(world), "Done");
    assert.equal(world.issues[3].state, "CLOSED");
    const body = world.issues[3].comments.find((c) => c.body.startsWith("<!-- complete:v1 issue=3 -->")).body;
    assert.ok(body.includes(COMMIT));
    assert.equal(lockCalls.acquired, 1);
    assert.equal(parseClaims(world.issues[3].comments, 3, { endAuthors: ["mbelinkie"] }).live, null, "the completion ends the claim");
  }
});

test("complete refuses unless the issue is In review and has a review record", async () => {
  const progress = inProgressWorld("Producer");
  progress.issues[3].comments.push(acceptComment());
  const a = setup({ world: progress });
  assert.equal((await a.lifecycle.complete(3)).code, "STATUS_NOT_IN_REVIEW");
  noWrites(a.transport);
  const noReview = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()] });
  noReview.issues[3].comments.splice(1, 1); // remove the review comment
  noReview.issues[3].comments.push(acceptComment());
  const b = setup({ world: noReview });
  assert.equal((await b.lifecycle.complete(3)).code, "NO_REVIEW_RECORD");
  noWrites(b.transport);
});

// ---- complete: reachability ----------------------------------------------

test("complete refuses a tested commit that is not pushed or not reachable from main", async () => {
  const notPushed = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()] });
  delete notPushed.compare[`main...${COMMIT}`];
  let r = setup({ world: notPushed });
  assert.equal((await r.lifecycle.complete(3)).code, "COMMIT_NOT_PUSHED");
  noWrites(r.transport);
  for (const verdict of ["ahead", "diverged"]) {
    const world = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()] });
    world.compare[`main...${COMMIT}`] = verdict;
    r = setup({ world });
    assert.equal((await r.lifecycle.complete(3)).code, "COMMIT_NOT_ON_BASELINE", verdict);
    noWrites(r.transport);
    assert.ok(r.transport.restPaths().some((p) => p.includes(`/compare/main...${COMMIT}`)));
  }
  for (const verdict of ["identical", "behind"]) {
    const world = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()] });
    world.compare[`main...${COMMIT}`] = verdict;
    assert.equal((await setup({ world }).lifecycle.complete(3)).ok, true, verdict);
  }
});

test("a special branch is accepted only when the issue records it", async () => {
  const build = (baseline) => {
    const world = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()] });
    world.issues[3].body = contractBody({ acceptance: "Producer", baseline });
    world.compare[`claude/special...${COMMIT}`] = "identical";
    return world;
  };
  const unrecorded = setup({ world: build("`main`, with #4 merged.") });
  assert.equal((await unrecorded.lifecycle.complete(3, { specialBranch: "claude/special" })).code, "SPECIAL_BRANCH_NOT_RECORDED");
  noWrites(unrecorded.transport);
  const recorded = setup({ world: build("`claude/special`, because the dependants branch from it.") });
  const ok = await recorded.lifecycle.complete(3, { specialBranch: "claude/special" });
  assert.equal(ok.ok, true);
  assert.ok(recorded.world.issues[3].comments.at(-1).body.includes("claude/special"));
});

// ---- complete: partial writes and verification ---------------------------

test("complete recovers 'comment posted, status failed' without a second comment", async () => {
  const world = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()], extra: { statusFailures: [502] } });
  const first = setup({ world });
  const partial = await first.lifecycle.complete(3);
  assert.equal(partial.code, "PARTIAL_WRITE");
  assert.equal(partial.commentPosted, true);
  const second = setup({ world });
  const done = await second.lifecycle.complete(3);
  assert.equal(done.ok, true);
  assert.deepEqual(second.transport.mutationNames(), ["LifecycleSetStatus", "LifecycleCloseIssue"]);
  assert.equal(world.issues[3].comments.filter((c) => c.body.startsWith("<!-- complete:v1")).length, 1);
});

test("complete recovers 'Done but not closed' and 'closed but not Done' with only the missing write", async () => {
  const doneNotClosed = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()], extra: { closeFailures: [502] } });
  const a1 = setup({ world: doneNotClosed });
  const partial = await a1.lifecycle.complete(3);
  assert.equal(partial.code, "PARTIAL_WRITE");
  assert.equal(partial.statusSet, true);
  assert.equal(partial.closed, false);
  const a2 = setup({ world: doneNotClosed });
  assert.equal((await a2.lifecycle.complete(3)).ok, true);
  assert.deepEqual(a2.transport.mutationNames(), ["LifecycleCloseIssue"]);

  const closedNotDone = reviewedWorld({ acceptance: "Producer", comments: [acceptComment(), { id: "C_c", createdAt: "2026-10-01T07:00:00Z", body: `<!-- complete:v1 issue=3 -->\nAccepted. ${COMMIT}` }] });
  closedNotDone.issues[3].state = "CLOSED";
  const b = setup({ world: closedNotDone });
  const result = await b.lifecycle.complete(3);
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.deepEqual(b.transport.mutationNames(), ["LifecycleSetStatus"]);
  assert.equal(statusOf(closedNotDone), "Done");
  assert.equal(closedNotDone.issues[3].comments.filter((c) => c.body.startsWith("<!-- complete:v1")).length, 1);
});

test("an already completed issue is a no-op", async () => {
  const world = reviewedWorld({ acceptance: "Producer", comments: [acceptComment(), { id: "C_c", createdAt: "x", body: `<!-- complete:v1 issue=3 -->\nok ${COMMIT}` }] });
  world.issues[3].state = "CLOSED";
  world.issues[3].items[0].status = "Done";
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.complete(3);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCompleted, true);
  noWrites(transport);
});

test("complete does not claim success when the re-read shows the status write did not take", async () => {
  const world = reviewedWorld({ acceptance: "Producer", comments: [acceptComment()], extra: { dropStatusWrite: true } });
  const { lifecycle } = setup({ world });
  const result = await lifecycle.complete(3);
  assert.equal(result.ok, false);
  assert.equal(result.code, "VERIFY_FAILED");
  assert.match(result.message, /Done/);
});

test("completing a closed issue that was never reviewed or accepted is refused (no closing outside this path)", async () => {
  const world = reviewedWorld({ acceptance: "Producer" });
  world.issues[3].state = "CLOSED";
  const { lifecycle, transport } = setup({ world });
  const result = await lifecycle.complete(3);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACCEPTANCE_MISSING");
  noWrites(transport);
});

// ---- stale claims ---------------------------------------------------------

test("stale reports mismatches between issue state, board status and claim records, and writes nothing", async () => {
  const cases = [
    [(w) => { w.issues[3].items[0].status = "Ready"; w.issues[3].comments = [claimComment(OTHER)]; }, "CLAIM_STATUS_MISMATCH"],
    [(w) => { w.issues[3].comments = []; }, "STATUS_WITHOUT_CLAIM"],
    [(w) => { w.issues[3].state = "CLOSED"; w.issues[3].comments = [claimComment(OTHER)]; }, "CLOSED_NOT_DONE"],
    [(w) => { w.issues[3].items[0].status = "Done"; w.issues[3].comments = [claimComment(OTHER)]; }, "DONE_BUT_OPEN"],
    [(w) => { w.issues[3].items[0].status = "Done"; w.issues[3].state = "CLOSED"; w.issues[3].comments = []; }, "NO_COMPLETION_RECORD"],
  ];
  for (const [mutate, code] of cases) {
    const world = inProgressWorld();
    mutate(world);
    const { lifecycle, transport } = setup({ world });
    const result = await lifecycle.stale(3);
    assert.equal(result.ok, true);
    assert.ok(result.discrepancies.map((d) => d.code).includes(code), `${code} in ${JSON.stringify(result.discrepancies)}`);
    noWrites(transport);
  }
  const clean = setup({ world: inProgressWorld() });
  const ok = await clean.lifecycle.stale(3);
  assert.deepEqual(ok.discrepancies, []);
  assert.equal(ok.liveClaim.executionId, SELF);
});

test("claim age is reported but is never evidence that the execution stopped", async () => {
  const world = inProgressWorld();
  world.issues[3].comments = [claimComment(OTHER, 3, { createdAt: "1970-01-01T00:00:00Z" })];
  const { lifecycle, transport } = setup({ world });
  const report = await lifecycle.stale(3);
  assert.equal(report.liveClaim.executionId, OTHER);
  assert.equal(report.stopEvidence, false);
  assert.match(report.note, /age alone is never proof/i);
  assert.ok(report.liveClaim.ageHours > 1000);
  noWrites(transport);
  const takeover = setup({ world, env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  assert.equal((await takeover.lifecycle.claim(3, { executionId: VERIFIER, branch: "claude/x", startCommit: COMMIT, model: "deepseek-v4-pro", effort: "high" })).code, "CLAIM_HELD");
  noWrites(takeover.transport);
});

test("release refuses without recorded operator evidence, before any request", async () => {
  const base = { stoppedExecution: OTHER, confirmedBy: "mbelinkie", evidence: "terminal closed, process gone" };
  for (const [extra, code] of [
    [{ evidence: "" }, "RELEASE_EVIDENCE_REQUIRED"], [{ confirmedBy: " " }, "RELEASE_EVIDENCE_REQUIRED"],
    [{ stoppedExecution: "nope" }, "EXECUTION_ID_INVALID"], [{ stoppedExecution: SELF }, "SELF_RELEASE"],
  ]) {
    const { lifecycle, transport } = setup({ world: inProgressWorld() });
    const result = await lifecycle.release(3, { ...base, ...extra });
    assert.equal(result.code, code);
    assert.equal(transport.calls.length, 0, code);
  }
});

test("release refuses when the current run identity is ambiguous, before any request", async () => {
  const { lifecycle, transport } = setup({
    world: inProgressWorld(),
    env: { CODEX_THREAD_ID: SELF, CODEX_SESSION_ID: OTHER },
  });
  const result = await lifecycle.release(3, {
    stoppedExecution: SELF,
    confirmedBy: "mbelinkie",
    evidence: "terminal closed, process gone",
  });
  assert.equal(result.code, "EXECUTION_ID_AMBIGUOUS");
  assert.equal(transport.calls.length, 0);
});

test("release refuses when the named execution is not the live claimant", async () => {
  const world = inProgressWorld();
  world.issues[3].comments = [claimComment(OTHER)];
  const a = setup({ world });
  assert.equal((await a.lifecycle.release(3, { stoppedExecution: VERIFIER, confirmedBy: "mbelinkie", evidence: "gone" })).code, "CLAIM_MISMATCH");
  noWrites(a.transport);
  const none = inProgressWorld();
  none.issues[3].comments = [];
  const b = setup({ world: none });
  assert.equal((await b.lifecycle.release(3, { stoppedExecution: OTHER, confirmedBy: "mbelinkie", evidence: "gone" })).code, "NO_LIVE_CLAIM");
  noWrites(b.transport);
});

test("release records the confirmation, ends the claim, and returns the issue to Ready for a new claim", async () => {
  const world = inProgressWorld();
  world.issues[3].comments = [claimComment(OTHER)];
  const { lifecycle, transport } = setup({ world, env: {} });
  const result = await lifecycle.release(3, { stoppedExecution: OTHER, confirmedBy: "mbelinkie", evidence: "laptop was shut down; session cannot resume" });
  assert.equal(result.ok, true);
  assert.deepEqual(transport.mutationNames(), ["LifecycleAddComment", "LifecycleSetStatus"]);
  const body = world.issues[3].comments.at(-1).body;
  assert.ok(body.startsWith("<!-- release:v1 issue=3 -->\n"));
  for (const needle of [OTHER, "mbelinkie", "laptop was shut down"]) assert.ok(body.includes(needle), needle);
  assert.equal(statusOf(world), "Ready");
  assert.equal(parseClaims(world.issues[3].comments, 3, { endAuthors: ["mbelinkie"] }).live, null);
  const next = setup({ world, env: { CLAUDE_CODE_SESSION_ID: VERIFIER } });
  const claimed = await next.lifecycle.claim(3, { executionId: VERIFIER, branch: "codex/x", startCommit: COMMIT, model: "deepseek-v4-pro", effort: "high" });
  assert.equal(claimed.ok, true);
});

test("release recovers a partial write without a second comment", async () => {
  const world = inProgressWorld("Automated", { statusFailures: [502] });
  world.issues[3].comments = [claimComment(OTHER)];
  const args = { stoppedExecution: OTHER, confirmedBy: "mbelinkie", evidence: "gone" };
  const first = setup({ world });
  assert.equal((await first.lifecycle.release(3, args)).code, "PARTIAL_WRITE");
  const second = setup({ world });
  assert.equal((await second.lifecycle.release(3, args)).ok, true);
  assert.deepEqual(second.transport.mutationNames(), ["LifecycleSetStatus"]);
  assert.equal(world.issues[3].comments.filter((c) => c.body.startsWith("<!-- release:v1")).length, 1);
  const third = setup({ world });
  assert.equal((await third.lifecycle.release(3, args)).alreadyReleased, true);
  noWrites(third.transport);
});

// ---- structure ------------------------------------------------------------

test("part 2 reaches GitHub only through the gate session", () => {
  const text = fs.readFileSync(new URL("scripts/roadmap/lifecycle-finish.mjs", root), "utf8");
  assert.ok(!/child_process|\bfetch\s*\(|api\.github\.com/.test(text));
  assert.match(text, /gate\.session\(/);
  const help = fs.readFileSync(new URL("scripts/roadmap/lifecycle.mjs", root), "utf8");
  for (const op of ["review", "verify", "complete", "stale", "release"]) assert.ok(help.includes(`  ${op} <n>`), `help lists ${op}`);
});

test("the closing mutation lives in exactly one place", () => {
  const files = ["lifecycle.mjs", "lifecycle-finish.mjs", "lifecycle-core.mjs"];
  const holders = files.filter((f) => /closeIssue\(/.test(fs.readFileSync(new URL(`scripts/roadmap/${f}`, root), "utf8")));
  assert.deepEqual(holders, ["lifecycle-finish.mjs"], "only complete may close an issue");
});

test("config still has the same routing and no new top-level keys", () => {
  assert.deepEqual(Object.keys(config), ["_comment", "repository", "project", "documents", "fields", "crossRepoPrerequisites", "routing"]);
  assert.ok(completeComment(1).body.includes("complete:v1"));
});
