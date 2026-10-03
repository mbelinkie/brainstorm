import test from "node:test";
import assert from "node:assert/strict";
import { shouldAudit, applyCategoryOverrides, ladderStartFor, buildReport, formatReport } from "../tools/delegate/core/report.mjs";
import { validateTriage, normalizeSlices } from "../tools/delegate/core/recon.mjs";

test("audit sample: every pilot accept, then 1 in 5 to 30, then 1 in 20", () => {
  const audited = Array.from({ length: 100 }, (_, i) => i + 1).filter((n) => shouldAudit(n));
  assert.deepEqual(audited, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 60, 80, 100]);
  assert.equal(shouldAudit(0), false);
  assert.deepEqual([1, 2, 3, 4, 5].filter((n) => shouldAudit(n, { pilotAll: 0, earlyRate: 5, earlyUntil: 30, steadyRate: 20 })), [5]);
});

test("category overrides only ever raise a lane, and set the ladder start", () => {
  const o = { Ops: { minLane: "protected" }, Player: { minLane: "standard", ladderStart: 2 } };
  assert.equal(applyCategoryOverrides("express", "Ops", o), "protected");
  assert.equal(applyCategoryOverrides("express", "Player", o), "standard");
  assert.equal(applyCategoryOverrides("protected", "Player", o), "protected", "never lowered");
  assert.equal(applyCategoryOverrides("express", "Other", o), "express");
  assert.equal(ladderStartFor("Player", o), 2);
  assert.equal(ladderStartFor("Other", o), 0);
});

const ticket = (n, extra = {}) => ({
  n, phase: "finished", lane: "standard", category: "Player", finishedAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`,
  recon: { verified: 9, total: 10 }, deepseek: { usdEstimate: 0.03 },
  codexSessions: [{ role: "controller", credits: 1.5, usage: { input: 100000, cached: 80000, output: 4000 } }],
  doneSlices: [{ attempts: [{ attempt: 1, model: "deepseek-flash", result: "FAILED" }, { attempt: 2, model: "deepseek-flash", result: "GREEN" }] }],
  ...extra,
});

test("report: reopen-rate promotion, Flash start rung, recon quality, audits and budgets", () => {
  const tickets = Array.from({ length: 20 }, (_, i) => ticket(i + 1));
  const reopens = { 19: { reopened: true }, 20: { reopened: true } };
  const r = buildReport({ tickets, reopens, audits: { 3: { defect: true } } });
  assert.equal(r.totals.finished, 20);
  assert.equal(r.totals.reopened, 2);
  assert.equal(r.totals.creditsPerKeptTicket, 1.67, "30 credits over 18 kept tickets");
  const row = r.categories.find((c) => c.category === "Player");
  assert.equal(row.reopenRateLast10, 0.2);
  assert.equal(row.flashFirstPassRate, 0);
  assert.ok(r.recommendations.some((x) => /Promote "Player" from standard to protected/.test(x)));
  assert.ok(r.recommendations.some((x) => /Start "Player" at the Pro rung/.test(x)));
  assert.ok(r.recommendations.some((x) => /audits found 1 defect/.test(x)));
  assert.ok(r.recommendations.some((x) => /Budget for controller/.test(x)));
  assert.match(formatReport(r), /Kept tickets: 18\/20/);
  const clean = buildReport({ tickets: Array.from({ length: 20 }, (_, i) => ticket(i + 1, { recon: { verified: 5, total: 10 } })) });
  assert.ok(clean.recommendations.some((x) => /Consider demoting "Player"/.test(x)));
  assert.ok(clean.recommendations.some((x) => /deepseek-v4-pro/.test(x)), "weak recon suggests the Pro scout");
  assert.deepEqual(buildReport({ tickets: [] }).recommendations, []);
});

test("slices: every case in exactly one slice, narrow scopes; default is one slice", () => {
  const base = { n: 1, fit: "ok", lane: "standard", cases: [{ id: "A1", expect: "x" }, { id: "A2", expect: "y" }], scope: ["a.js", "b.js"] };
  const good = { ...base, slices: [{ id: "S1", goal: "first", scope: ["a.js"], cases: ["A1"] }, { id: "S2", goal: "second", scope: ["b.js"], cases: ["A2"] }] };
  assert.equal(validateTriage({ tickets: [good] }, [1]).ok, true);
  const missing = { ...base, slices: [{ id: "S1", goal: "first", scope: ["a.js"], cases: ["A1"] }] };
  assert.match(validateTriage({ tickets: [missing] }, [1]).problems.join(), /A2 is in no slice/);
  const twice = { ...base, slices: [{ id: "S1", goal: "g", scope: ["a.js"], cases: ["A1", "A2"] }, { id: "S2", goal: "g", scope: ["b.js"], cases: ["A2"] }] };
  assert.match(validateTriage({ tickets: [twice] }, [1]).problems.join(), /more than one slice: A2 /);
  // Pilot (#44): Sol put A10 and A16 in both slices. One problem names every duplicated id, once.
  const cases3 = [{ id: "A1", expect: "x" }, { id: "A2", expect: "y" }, { id: "A3", expect: "z" }];
  const dup = { ...base, cases: cases3, slices: [{ id: "S1", goal: "g", scope: ["a.js"], cases: ["A1", "A2", "A3"] }, { id: "S2", goal: "g", scope: ["b.js"], cases: ["A2", "A3"] }, { id: "S3", goal: "g", scope: ["b.js"], cases: ["A3"] }] };
  const dupProblems = validateTriage({ tickets: [dup] }, [1]).problems.filter((p) => /more than one slice/.test(p));
  assert.deepEqual(dupProblems, ["#1 cases in more than one slice: A2, A3 (every case belongs to exactly one slice)"]);
  const broad = { ...base, slices: [{ id: "S1", goal: "g", scope: ["**"], cases: ["A1", "A2"] }] };
  assert.equal(validateTriage({ tickets: [broad] }, [1]).ok, false);
  assert.deepEqual(normalizeSlices(base), [{ id: "S1", goal: "the whole ticket", scope: ["a.js", "b.js"], allow: [], caseIds: ["A1", "A2"] }]);
  assert.deepEqual(normalizeSlices(good).map((s) => [s.id, s.caseIds]), [["S1", ["A1"]], ["S2", ["A2"]]]);
});
