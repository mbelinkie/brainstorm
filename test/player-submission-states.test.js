import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sameSubmittedAnswer, submissionStatusView } from "../quiz-core.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// C11 — pending, confirmed, rejected and retryable must be four distinct
// visible states. They were two: a rejected answer borrowed the confirmed and
// locked treatment, and its message lived only in the DOM.

test("every submission state has its own message and its own class", () => {
  const outcomes = ["idle", "sending", "confirmed", "failed", "abandoned"];
  const views = outcomes.map((outcome) => submissionStatusView({ outcome, phase: "open", questionType: "short_answer", manualSubmit: true }));

  assert.deepEqual(views.map((view) => view.state), ["idle", "sending", "confirmed", "failed", "abandoned"]);
  assert.equal(new Set(views.map((view) => view.message)).size, outcomes.length, "two states share a message");
  assert.equal(new Set(views.map((view) => view.className)).size, outcomes.length, "two states share a visual treatment");
});

test("a rejected answer is never dressed as a confirmed or locked one", () => {
  const failed = submissionStatusView({ outcome: "failed", phase: "open", questionType: "multi_fill_in_the_blank" });
  const confirmed = submissionStatusView({ outcome: "confirmed", phase: "open", questionType: "multi_fill_in_the_blank" });
  const locked = submissionStatusView({ outcome: "confirmed", phase: "locked", questionType: "multi_fill_in_the_blank" });

  // This is the exact collapse the review found: failure used to render with
  // class "submitted locked", the same string as a safely locked question.
  assert.notEqual(failed.className, locked.className);
  assert.notEqual(failed.className, confirmed.className);
  assert.doesNotMatch(failed.className, /\bsubmitted\b/, "the green confirmation class must not appear on a failure");
  assert.match(failed.message, /not saved/i);
  assert.match(failed.message, /retry/i, "a retryable failure must say how to retry");
  assert.match(confirmed.message, /saved/i);
});

test("submission messages match how the question is answered", () => {
  assert.match(submissionStatusView({ outcome: "sending", questionType: "multi_fill_in_the_blank" }).message, /Saving answers/);
  assert.match(submissionStatusView({ outcome: "sending", questionType: "single_choice" }).message, /Saving selection/);
  assert.match(submissionStatusView({ outcome: "idle", questionType: "short_answer", manualSubmit: true }).message, /then submit/i);
  assert.match(submissionStatusView({ outcome: "idle", questionType: "single_choice" }).message, /automatically/i);
  assert.match(submissionStatusView({ outcome: "abandoned", questionType: "single_choice" }).message, /moved on/i);
});

test("host-driven phases override any local outcome", () => {
  // Once the host has locked or revealed, the phone reports the room, not the
  // last thing this browser did.
  assert.equal(submissionStatusView({ outcome: "sending", phase: "locked" }).message, "Answers are locked.");
  assert.equal(submissionStatusView({ outcome: "failed", phase: "reveal" }).message, "Answer revealed.");
  assert.match(submissionStatusView({ outcome: "confirmed", phase: "complete" }).message, /final leaderboard/);
  // An unconfirmed answer must not pick up the green confirmation colour just
  // because the question was revealed.
  assert.equal(submissionStatusView({ outcome: "failed", phase: "reveal" }).className, "");
  assert.match(submissionStatusView({ outcome: "confirmed", phase: "reveal" }).className, /submitted/);
});

test("sameSubmittedAnswer decides whether what the phone shows is what the server took", () => {
  assert.equal(sameSubmittedAnswer("b", "b"), true);
  assert.equal(sameSubmittedAnswer("b", "c"), false);
  assert.equal(sameSubmittedAnswer(null, null), true);
  assert.equal(sameSubmittedAnswer(null, "b"), false);
  // Multi-blank answers are keyed objects, and key order is not meaningful.
  assert.equal(sameSubmittedAnswer({ "1": "clocks", "2": "yellow" }, { "2": "yellow", "1": "clocks" }), true);
  // The finale case from the review: nine of ten blanks saved, one edited
  // after the last confirmation. That is NOT the confirmed answer.
  assert.equal(sameSubmittedAnswer({ "1": "clocks", "2": "yellow" }, { "1": "clocks", "2": "trouble" }), false);
  assert.equal(sameSubmittedAnswer({ "1": "clocks" }, { "1": "clocks", "2": "yellow" }), false);
  assert.equal(sameSubmittedAnswer(["a", "b"], ["a", "b"]), true);
  assert.equal(sameSubmittedAnswer(["a", "b"], ["b", "a"]), false);
});

test("wiring: the player status bar is rebuilt from the recorded outcome, not from a sticky flag", () => {
  const start = app.indexOf("function renderPlayer() {");
  const end = app.indexOf("function render()");
  assert.ok(start > -1 && end > start, "expected renderPlayer to precede render()");
  const renderPlayer = app.slice(start, end);

  assert.match(renderPlayer, /submissionStatusView\(submissionStatusInputs\(\)\)/);
  assert.match(renderPlayer, /data-submission-status class="\$\{submissionStatus\.className\}"/);
  // The bug: the message was recomputed from a sessionStorage flag that was
  // set on the first success for a question and never cleared, so a later
  // failure was redrawn as "Answers saved".
  assert.doesNotMatch(renderPlayer, /sessionStorage\.getItem/, "renderPlayer must not read a submitted flag directly");
  assert.doesNotMatch(renderPlayer, /Answers saved\. You can keep editing/, "the messages belong to quiz-core.js");
});

test("wiring: a confirmed submission records which answer was confirmed", () => {
  const start = app.indexOf("function rememberSubmission(");
  assert.ok(start > -1, "expected app.js to define rememberSubmission");
  const remember = app.slice(start, app.indexOf("\n}", start));
  assert.match(remember, /JSON\.stringify\(\{ answer \}\)/, "the stored record must carry the answer, not just `true`");
  assert.doesNotMatch(remember, /"true"/);

  const readerStart = app.indexOf("function submissionOutcomeNow(");
  assert.ok(readerStart > -1, "expected app.js to define submissionOutcomeNow");
  const reader = app.slice(readerStart, app.indexOf("\n}", readerStart));
  assert.match(reader, /sameSubmittedAnswer/, "a confirmation must be checked against the answer on screen");
  assert.match(reader, /record\.legacy/, "phones mid-show still hold the old \"true\" flag");
});

// C12 — the manual Submit path used to call roomApi.submitAnswer directly and
// turn a benign host-initiated revision bump into a modal on the player's
// phone plus a Sentry issue, while the identical race on a single_choice
// question recovered silently. It was routed through the recovery wrapper on
// 2026-08-17; nothing pinned it there, so this is the guard.
test("both submit paths go through the one recovery-aware client", () => {
  const handlerStart = app.indexOf('document.querySelector("[data-submit]")?.addEventListener("click"');
  assert.ok(handlerStart > -1, "expected a [data-submit] click handler in app.js");
  const manual = app.slice(handlerStart, app.indexOf('document.querySelector("[data-player]")'));

  const autoStart = app.indexOf("function queueAutoSubmission");
  assert.ok(autoStart > -1, "expected app.js to define queueAutoSubmission");
  const auto = app.slice(autoStart, app.indexOf("function updateMatchingSelectAvailability"));

  for (const [name, source] of [["manual submit", manual], ["auto-submit", auto]]) {
    assert.match(source, /await submitLiveAnswerWithRecovery\(\{ roomCode, playerToken: playerId, questionId, answer, serverRevision \}\)/, `${name} must use the recovery wrapper`);
    assert.doesNotMatch(source, /roomApi\.submitAnswer/, `${name} must not call the raw RPC`);
    // A stale revision on a still-open question is recovered inside the
    // wrapper; neither path may report it to the player or to Sentry.
    assert.doesNotMatch(source, /stale-revision/, `${name} must not re-classify rejections itself`);
  }

  // Both paths record the roster identity the host counts by, not the local
  // auth token — the identity confusion the 2026-08-17 roster fix removed.
  assert.match(manual, /state\.submitted\[doorPlayerRecordId \|\| playerId\]/);
  assert.match(auto, /state\.submitted\[doorPlayerRecordId \|\| playerId\]/);
});
