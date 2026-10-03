// The guards (HARNESS_SPEC section 5), as pure functions over facts the
// harness gathers from git, the filesystem and JUnit output. Each returns
// { id, ok, detail }. The worker's own report is never an input.
//
// Static guards run first; the test guards (acceptance, regression) run only
// when every static guard passes. A lane-limit or protected-path failure is a
// promotion, not a repairable defect; `classify` reports which.

import { matchesAny } from "./paths.mjs";
import { acceptancePassed } from "./junit.mjs";

const pass = (id, detail = "") => ({ id, ok: true, detail });
const failGuard = (id, detail) => ({ id, ok: false, detail });

const WEAKENING = [
  { re: /\b(?:test|it|describe|suite)\.(?:skip|only|todo)\s*\(/, what: "skip/only/todo call" },
  { re: /\{\s*[^}]*\b(?:skip|only|todo)\s*:\s*(?:true|["'`])/, what: "skip/only/todo option" },
  { re: /\bt\.(?:skip|todo)\s*\(/, what: "t.skip/t.todo" },
];
const SUPPRESSIONS = [
  { re: /eslint-disable/, what: "eslint-disable" },
  { re: /@ts-(?:ignore|nocheck|expect-error)/, what: "TypeScript suppression" },
];
const PUBLIC_UNSAFE = [
  { re: /(?:^|[\s"'`(=])\/(?:Users|home)\/[A-Za-z0-9._-]+\//, what: "absolute local path" },
  { re: /[A-Za-z]:\\(?:Users|Documents and Settings)\\/, what: "absolute Windows path" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, what: "API-key-shaped string" },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/, what: "GitHub token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "private key" },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./, what: "JWT" },
];

function addedMatches(addedLines, patterns, pathFilter = () => true) {
  const hits = [];
  for (const [filePath, lines] of addedLines) {
    if (!pathFilter(filePath)) continue;
    for (const line of lines) {
      for (const { re, what } of patterns) if (re.test(line)) hits.push(`${filePath}: ${what}`);
    }
  }
  return [...new Set(hits)];
}

// facts: {
//   changedPaths: string[], addedLines: Map(path -> string[]), totals: { files, lines },
//   lockMismatches: string[], baseTestCount: number|null, testCount: number|null,
//   syntaxErrors: string[], whitespaceErrors: string,
// }
// ticket: { lane, writeScope: string[], allow: string[] }
// config: { protectedPaths, configPaths, dependencyFiles, testFileGlobs, lanes }
export function staticGuards(facts, ticket, config) {
  const allow = new Set(ticket.allow ?? []);
  const changed = facts.changedPaths ?? [];
  const results = [];

  results.push(facts.lockMismatches?.length
    ? failGuard("locked-tests", `acceptance files changed: ${facts.lockMismatches.join(", ")}`)
    : pass("locked-tests"));

  const outside = changed.filter((p) => !matchesAny(p, ticket.writeScope ?? []) && !matchesAny(p, ticket.harnessPaths ?? []));
  results.push(outside.length ? failGuard("write-scope", `outside scope: ${outside.join(", ")}`) : pass("write-scope"));

  const protectedHits = ticket.lane === "protected" ? [] : changed.filter((p) => matchesAny(p, config.protectedPaths ?? []));
  results.push(protectedHits.length ? failGuard("protected-paths", `protected: ${protectedHits.join(", ")}`) : pass("protected-paths"));

  const weakening = [];
  // testCount undefined = not measured yet (the pre-test pass); null = measured but unknown.
  if (facts.baseTestCount === null || facts.baseTestCount === undefined) weakening.push("base test count unknown");
  else if (facts.testCount === null) weakening.push("test count unknown");
  else if (facts.testCount !== undefined && facts.testCount < facts.baseTestCount) weakening.push(`test count fell ${facts.baseTestCount} -> ${facts.testCount}`);
  const isTestFile = (p) => matchesAny(p, config.testFileGlobs ?? ["test/**"]);
  weakening.push(...addedMatches(facts.addedLines ?? new Map(), WEAKENING, isTestFile));
  if (!allow.has("suppressions")) weakening.push(...addedMatches(facts.addedLines ?? new Map(), SUPPRESSIONS));
  results.push(weakening.length ? failGuard("no-test-weakening", weakening.join("; ")) : pass("no-test-weakening"));

  const configHits = allow.has("config") ? [] : changed.filter((p) => matchesAny(p, config.configPaths ?? []));
  results.push(configHits.length ? failGuard("config-untouched", `changed: ${configHits.join(", ")}`) : pass("config-untouched"));

  const depHits = allow.has("deps") ? [] : changed.filter((p) => matchesAny(p, config.dependencyFiles ?? []));
  results.push(depHits.length ? failGuard("no-new-dependencies", `changed: ${depHits.join(", ")}`) : pass("no-new-dependencies"));

  const syntax = [...(facts.syntaxErrors ?? [])];
  if (facts.whitespaceErrors && String(facts.whitespaceErrors).trim()) syntax.push(`git diff --check: ${String(facts.whitespaceErrors).trim().split("\n")[0]}`);
  results.push(syntax.length ? failGuard("syntax", syntax.join("; ")) : pass("syntax"));

  const limits = config.lanes?.[ticket.lane];
  const totals = facts.totals ?? { files: 0, lines: 0 };
  if (!limits) results.push(failGuard("lane-limits", `no limits configured for lane ${ticket.lane}`));
  else if (totals.files > limits.maxFiles || totals.lines > limits.maxLines) {
    results.push(failGuard("lane-limits", `${totals.files} files / ${totals.lines} lines exceeds ${ticket.lane} (${limits.maxFiles} / ${limits.maxLines})`));
  } else results.push(pass("lane-limits", `${totals.files} files / ${totals.lines} lines`));

  const unsafe = addedMatches(facts.addedLines ?? new Map(), PUBLIC_UNSAFE);
  results.push(unsafe.length ? failGuard("public-safety", unsafe.join("; ")) : pass("public-safety"));

  return results;
}

// acceptanceStatusById from junit.acceptanceStatus; regression: { exitCode, counts }
export function testGuards({ acceptanceStatusById, regression }) {
  const results = [];
  const acceptance = acceptancePassed(acceptanceStatusById ?? {});
  const noCases = Object.keys(acceptanceStatusById ?? {}).length === 0;
  results.push(noCases
    ? failGuard("acceptance", "no acceptance cases to check")
    : acceptance.ok ? pass("acceptance") : failGuard("acceptance", acceptance.problems.join("; ")));
  if (!regression) results.push(failGuard("regression", "regression suite did not run"));
  else if (regression.exitCode !== 0 || (regression.counts?.fail ?? 1) > 0 || (regression.counts?.cancelled ?? 0) > 0) {
    results.push(failGuard("regression", `exit ${regression.exitCode}, ${regression.counts?.fail ?? "?"} failed`));
  } else results.push(pass("regression", `${regression.counts.pass}/${regression.counts.tests} passed`));
  return results;
}

// Express tickets without new acceptance cases rely on the regression suite only.
export function regressionOnlyGuards({ regression }) {
  return testGuards({ acceptanceStatusById: { _: { found: 1, passed: 1, failed: 0, skipped: 0 } }, regression })
    .map((r) => (r.id === "acceptance" ? { id: "acceptance", ok: true, detail: "no acceptance cases (express)" } : r));
}

// What a failed guard set means for the ladder.
export function classify(results) {
  const failed = results.filter((r) => !r.ok).map((r) => r.id);
  if (failed.length === 0) return { outcome: "GREEN", failed };
  if (failed.includes("protected-paths")) return { outcome: "PROMOTE_PROTECTED", failed };
  if (failed.includes("lane-limits")) return { outcome: "PROMOTE_LANE", failed };
  return { outcome: "FAILED", failed };
}

export function formatGuardLines(results) {
  return results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.id}${r.detail ? `: ${r.detail}` : ""}`);
}
