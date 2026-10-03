import test from "node:test";
import assert from "node:assert/strict";
import { runLadder, failureExcerpt } from "../tools/delegate/core/ladder.mjs";
import { renderBundle } from "../tools/delegate/core/bundle.mjs";

const RUNGS = [
  { model: "deepseek-flash", effort: "high", fresh: true },
  { model: "deepseek-flash", effort: "high", fresh: false },
  { model: "deepseek-v4-pro", effort: "high", fresh: true },
  { model: "deepseek-v4-pro", effort: "max", fresh: true },
];

// script: list of per-call behaviours, in order.
function fakeDeps({ answers = [], applies = [], evaluations = [], spend = [] } = {}) {
  const log = [];
  let a = 0, p = 0, e = 0, s = 0;
  return {
    log,
    deps: {
      spendCheck: async () => { log.push("spend"); return spend[s++] ?? { ok: true }; },
      restoreBase: async () => { log.push("restore"); },
      callModel: async (rung, ctx) => { log.push(`call:${rung.model}/${rung.effort}#${ctx.attempt}${ctx.note ? "+note" : ""}${ctx.previous ? "+prev" : ""}`); return answers[a++] ?? { ok: true, artifact: { status: "done" }, facts: {} }; },
      apply: async () => { log.push("apply"); return applies[p++] ?? { ok: true }; },
      evaluate: async () => { log.push("evaluate"); return evaluations[e++] ?? { outcome: "FAILED", guards: [], failure: "boom", diff: "d" }; },
      record: () => {},
    },
  };
}

test("ladder stops at the first green attempt", async () => {
  const { deps, log } = fakeDeps({ evaluations: [{ outcome: "GREEN", guards: [] }] });
  const r = await runLadder({ rungs: RUNGS, deps });
  assert.equal(r.outcome, "GREEN");
  assert.equal(r.attempts.length, 1);
  assert.deepEqual(log, ["spend", "call:deepseek-flash/high#1", "apply", "evaluate"]);
});

test("ladder climbs Flash -> Flash (keeps state) -> Pro fresh -> Pro max, then caps", async () => {
  const { deps, log } = fakeDeps();
  const r = await runLadder({ rungs: RUNGS, deps });
  assert.equal(r.outcome, "CAPPED");
  assert.equal(r.attempts.length, 4);
  const calls = log.filter((l) => l.startsWith("call") || l === "restore");
  assert.deepEqual(calls, [
    "call:deepseek-flash/high#1",
    "call:deepseek-flash/high#2+prev",
    "restore",
    "call:deepseek-v4-pro/high#3+prev",
    "restore",
    "call:deepseek-v4-pro/max#4+prev",
  ]);
});

test("a repair restarts at the configured rung with the note", async () => {
  const { deps, log } = fakeDeps({ evaluations: [{ outcome: "GREEN", guards: [] }] });
  const r = await runLadder({ rungs: RUNGS, startRung: 2, note: "fix X", deps });
  assert.equal(r.outcome, "GREEN");
  assert.equal(log[1], "call:deepseek-v4-pro/high#1+note");
});

test("promotion outcomes end the ladder immediately", async () => {
  for (const outcome of ["PROMOTE_LANE", "PROMOTE_PROTECTED"]) {
    const { deps } = fakeDeps({ evaluations: [{ outcome, guards: [] }] });
    assert.equal((await runLadder({ rungs: RUNGS, deps })).outcome, outcome);
  }
});

test("spend stop and unreliable balance stop before any request", async () => {
  const { deps, log } = fakeDeps({ spend: [{ ok: false, code: "SPEND_CAP", message: "cap" }] });
  const r = await runLadder({ rungs: RUNGS, deps });
  assert.equal(r.outcome, "STOPPED");
  assert.equal(r.code, "SPEND_CAP");
  assert.deepEqual(log, ["spend"]);
});

test("provider failures retry once on the same rung, then stop (not a code defect)", async () => {
  const flaky = fakeDeps({ answers: [{ ok: false, code: "TRANSPORT" }], evaluations: [{ outcome: "GREEN", guards: [] }] });
  assert.equal((await runLadder({ rungs: RUNGS, deps: flaky.deps })).outcome, "GREEN");
  const down = fakeDeps({ answers: [{ ok: false, code: "HTTP_ERROR" }, { ok: false, code: "HTTP_ERROR" }] });
  const r = await runLadder({ rungs: RUNGS, deps: down.deps });
  assert.equal(r.outcome, "STOPPED");
  assert.equal(r.attempts.length, 0, "provider failures consume no rung");
});

test("SPLIT_NEEDED ends the ladder; invalid answers and rejected artifacts consume rungs", async () => {
  const split = fakeDeps({ answers: [{ ok: false, code: "SPLIT_NEEDED" }] });
  assert.equal((await runLadder({ rungs: RUNGS, deps: split.deps })).outcome, "SPLIT_NEEDED");
  const invalid = fakeDeps({ answers: [{ ok: false, code: "JSON_INVALID", message: "x" }], evaluations: [{ outcome: "GREEN", guards: [] }] });
  const r = await runLadder({ rungs: RUNGS, deps: invalid.deps });
  assert.equal(r.outcome, "GREEN");
  assert.equal(r.attempts.length, 2);
  const rejected = fakeDeps({ applies: [{ ok: false, code: "PATH_OUTSIDE_SCOPE", message: "x" }], evaluations: [{ outcome: "GREEN", guards: [] }] });
  assert.equal((await runLadder({ rungs: RUNGS, deps: rejected.deps })).attempts[0].result, "apply-rejected");
});

test("two blocked reports in a row stop the ladder for the Controller", async () => {
  const blocked = { ok: false, code: "BLOCKED", message: "needs decision" };
  const { deps } = fakeDeps({ applies: [blocked, blocked] });
  const r = await runLadder({ rungs: RUNGS, deps });
  assert.equal(r.outcome, "WORKER_BLOCKED");
  assert.equal(r.attempts.length, 2);
});

test("failure excerpt is capped and lists failing guards first", () => {
  const text = failureExcerpt({
    guards: [{ id: "syntax", ok: false, detail: "bad" }, { id: "x", ok: true }],
    failingTests: Array.from({ length: 50 }, (_, i) => ({ name: `t${i}`, message: "m" })),
  });
  const lines = text.split("\n");
  assert.equal(lines.length, 40);
  assert.equal(lines[0], "FAIL syntax: bad");
});

test("bundle renders evidence and refuses oversized diffs", () => {
  const ok = renderBundle({ ticket: 21, title: "T", lane: "standard", baseSha: "a".repeat(40), attempts: [{ model: "deepseek-flash", effort: "high", result: "GREEN" }], deepseekUsd: 0.031, cacheHitPercent: 81, models: ["deepseek-flash"], cases: [{ id: "A1", kind: "normal", given: "g", expect: "e" }], guardsPassed: 9, guardsTotal: 9, guardLines: [], diff: "+x", diffStat: "1 file" });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /# #21 T/);
  assert.match(ok.text, /guards: 9\/9 PASS/);
  assert.match(ok.text, /\$0\.031/);
  const big = renderBundle({ ticket: 1, diff: Array(401).fill("+x").join("\n") });
  assert.equal(big.code, "DIFF_TOO_LARGE");
});
