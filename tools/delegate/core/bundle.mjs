// Review bundle (HARNESS_SPEC section 6): the only ticket content a Controller
// reads. Pure rendering; the harness supplies every fact.

export const MAX_BUNDLE_DIFF_LINES = 400;

export function renderBundle(b) {
  const diffLines = String(b.diff ?? "").split("\n");
  if (diffLines.length > MAX_BUNDLE_DIFF_LINES) {
    return { ok: false, code: "DIFF_TOO_LARGE", message: `diff is ${diffLines.length} lines (max ${MAX_BUNDLE_DIFF_LINES}); split or escalate` };
  }
  const attempts = (b.attempts ?? []).map((a) => `${a.model}/${a.effort}:${a.result}`).join(", ") || "none";
  const cases = (b.cases ?? []).map((c) => `${c.id} ${c.kind ?? ""}: ${c.given ?? ""} -> ${c.expect ?? ""}`.trim());
  const caseMap = (b.caseMap ?? []).map((m) => `${m.case} -> ${m.test}: asserts ${m.asserts}`);
  const notes = (b.workerNotes ?? []).slice(0, 10).map((n) => `- ${String(n).slice(0, 200)}`);
  const lines = [
    `# #${b.ticket} ${b.title ?? ""}`.trim(),
    `lane: ${b.lane}  base: ${String(b.baseSha ?? "").slice(0, 12)}  attempts: ${(b.attempts ?? []).length} (${attempts})`,
    `DeepSeek: ${b.deepseekUsd === null || b.deepseekUsd === undefined ? "unknown" : `$${b.deepseekUsd.toFixed(3)}`}, cache hit ${b.cacheHitPercent ?? "unknown"}%, models ${(b.models ?? []).join(", ") || "none"}`,
    "",
    "## Decisions",
    ...(b.decisions ?? []).map((d) => `- ${d}`),
    "",
    "## Approved cases",
    ...(cases.length ? cases : ["(none: express lane uses the regression suite)"]),
    "",
    "## Case map",
    ...(caseMap.length ? caseMap : ["(none)"]),
    "",
    "## Evidence",
    `guards: ${b.guardsPassed}/${b.guardsTotal} PASS`,
    ...(b.guardLines ?? []).filter((l) => l.startsWith("FAIL")),
    `acceptance: ${b.acceptanceLine ?? "n/a"}`,
    `regression: ${b.regressionLine ?? "n/a"}`,
    `red-on-base: ${b.redOnBaseLine ?? "n/a"}`,
    `recon quotes: ${b.reconLine ?? "n/a"}`,
    `mutants: ${b.mutantLine ?? "not run (harness build step 7)"}`,
    `pre-review: ${b.preReviewLine ?? "not run (harness build step 7)"}`,
    "",
    "## Worker notes",
    ...(notes.length ? notes : ["(none)"]),
    "",
    "## Diff",
    "```diff",
    String(b.diffStat ?? "").trimEnd(),
    "",
    String(b.diff ?? "").trimEnd(),
    "```",
    "",
  ];
  return { ok: true, text: lines.join("\n") };
}
