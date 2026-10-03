import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { globToRegExp, matchesAny, isSafeRelativePath } from "../tools/delegate/core/paths.mjs";
import { parseNumstat, parseAddedLines, parseUntracked, summarizeChanges } from "../tools/delegate/core/diff.mjs";
import { parseJunit, caseIdOf, acceptanceStatus, acceptancePassed, failsForTheRightReason } from "../tools/delegate/core/junit.mjs";
import { checkResponse, stageArtifact, extractJson } from "../tools/delegate/core/artifacts.mjs";
import { staticGuards, testGuards, classify, formatGuardLines } from "../tools/delegate/core/guards.mjs";
import { makeLock, lockMismatches, sha256 } from "../tools/delegate/core/accept-lock.mjs";
import { validateConfig } from "../tools/delegate/core/config.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../tools/delegate/config.json", import.meta.url), "utf8"));

// ---- paths ---------------------------------------------------------------

test("globs: ** spans directories, * stays in one segment, ? is one char", () => {
  assert.ok(matchesAny("supabase/migrations/0037_x.sql", ["supabase/migrations/**"]));
  assert.ok(matchesAny("test/a.test.js", ["test/*.test.js"]));
  assert.ok(!matchesAny("test/sub/a.test.js", ["test/*.test.js"]));
  assert.ok(matchesAny("test/sub/a.test.js", ["test/**/*.test.js"]));
  assert.ok(matchesAny("test/a.test.js", ["test/**/*.test.js"]), "**/ matches zero directories");
  assert.ok(matchesAny(".env.local", [".env*"]));
  assert.ok(!matchesAny("src/.env.local", [".env*"]));
  assert.ok(matchesAny("src/.env.local", ["**/.env*"]));
  assert.ok(matchesAny("a1.js", ["a?.js"]));
  assert.ok(!matchesAny("quiz-core.js", ["quiz.core.js"]), "dots are literal");
  assert.equal(globToRegExp("x.js").test("xxjs"), false);
});

test("safe relative paths refuse absolute, traversal and backslashes", () => {
  for (const ok of ["a.js", "test/a.test.js", "docs/x/y.md"]) assert.ok(isSafeRelativePath(ok), ok);
  for (const bad of ["/etc/passwd", "../x", "a/../b", "./a", "a//b", "C:/x", "a\\b", "", "a/"]) assert.ok(!isSafeRelativePath(bad), bad);
});

// ---- diff ----------------------------------------------------------------

test("diff parsing: numstat, added lines, untracked files and totals", () => {
  const numstat = parseNumstat("3\t1\tquiz-core.js\n-\t-\tassets/x.png\n");
  assert.deepEqual(numstat[0], { path: "quiz-core.js", added: 3, removed: 1, binary: false });
  assert.equal(numstat[1].binary, true);
  const added = parseAddedLines([
    "diff --git a/quiz-core.js b/quiz-core.js",
    "--- a/quiz-core.js",
    "+++ b/quiz-core.js",
    "@@ -1,0 +2,2 @@",
    "+const a = 1;",
    "+// eslint-disable-next-line",
    "-old",
  ].join("\n"));
  assert.deepEqual(added.get("quiz-core.js"), ["const a = 1;", "// eslint-disable-next-line"]);
  assert.deepEqual(parseUntracked(" M x.js\n?? test/new.test.js\n"), ["test/new.test.js"]);
  const summary = summarizeChanges({ numstat, untracked: ["test/new.test.js"], readFile: () => "a\nb\n" });
  assert.equal(summary.totals.files, 3);
  assert.equal(summary.totals.lines, 6);
  assert.deepEqual(summary.addedLines.get("test/new.test.js"), ["a", "b"]);
});

// ---- junit ---------------------------------------------------------------

// Shape captured from `node --test --test-reporter=junit` (Node 22).
const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="[A1] passes" time="0.000946" classname="test"/>
	<testcase name="[A2] fails &lt;x>" time="0.001222" classname="test" failure="Expected values to be strictly equal:1 !== 2">
		<failure type="testCodeFailure" message="Expected values to be strictly equal:1 !== 2">
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
		</failure>
	</testcase>
	<testcase name="[A3] skipped" time="0.000144" classname="test">
		<skipped type="skipped" message="true"/>
	</testcase>
	<testcase name="A4 todo" time="0.000250" classname="test">
		<skipped type="todo" message="true"/>
	</testcase>
	<testsuite name="suite-ish" time="0.002586" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="vm">
		<testcase name="[A5] child ok" time="0.000270" classname="test"/>
	</testsuite>
	<testcase name="b.test.js" time="0.054257" classname="test" failure="test failed">
		<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }
		</failure>
	</testcase>
	<!-- tests 7 -->
	<!-- pass 3 -->
	<!-- fail 2 -->
	<!-- cancelled 0 -->
	<!-- skipped 1 -->
	<!-- todo 1 -->
</testsuites>`;

test("junit: statuses, assertion vs load failures, nested suites, counts", () => {
  const parsed = parseJunit(JUNIT);
  const byName = Object.fromEntries(parsed.cases.map((c) => [c.name, c]));
  assert.equal(byName["[A1] passes"].status, "passed");
  assert.equal(byName["[A2] fails <x>"].status, "failed");
  assert.equal(byName["[A2] fails <x>"].assertion, true);
  assert.equal(byName["[A3] skipped"].status, "skipped");
  assert.equal(byName["A4 todo"].status, "todo");
  assert.equal(byName["[A5] child ok"].suite, "suite-ish");
  assert.equal(byName["b.test.js"].status, "failed");
  assert.equal(byName["b.test.js"].assertion, false, "a load failure is not an assertion failure");
  assert.deepEqual(parsed.counts, { tests: 7, pass: 3, fail: 2, skipped: 1, todo: 1, cancelled: 0 });
  assert.equal(caseIdOf("[A12] x"), "A12");
  assert.equal(caseIdOf("A1 x"), null);
});

test("junit: acceptance pass requires every case present and passing, none skipped", () => {
  const parsed = parseJunit(JUNIT);
  const status = acceptanceStatus(parsed, ["A1", "A5"]);
  assert.equal(acceptancePassed(status).ok, true);
  assert.deepEqual(acceptancePassed(acceptanceStatus(parsed, ["A1", "A3"])).problems, ["A3 skipped"]);
  assert.deepEqual(acceptancePassed(acceptanceStatus(parsed, ["A1", "A9"])).problems, ["A9 missing"]);
  assert.deepEqual(acceptancePassed(acceptanceStatus(parsed, ["A2"])).problems, ["A2 failed"]);
});

test("junit: red-on-base needs assertion failures only", () => {
  const parsed = parseJunit(JUNIT);
  assert.equal(failsForTheRightReason(acceptanceStatus(parsed, ["A2"])).ok, true);
  assert.deepEqual(failsForTheRightReason(acceptanceStatus(parsed, ["A1"])).problems, ["A1 passes on base"]);
  assert.deepEqual(failsForTheRightReason(acceptanceStatus(parsed, ["A9"])).problems, ["A9 missing"]);
  const loadOnly = parseJunit(`<testsuites><testcase name="[B1] x" classname="test" failure="boom"><failure type="testCodeFailure" message="boom">TypeError: x is not a function</failure></testcase></testsuites>`);
  assert.match(failsForTheRightReason(acceptanceStatus(loadOnly, ["B1"])).problems[0], /without an assertion/);
});

// ---- artifacts -----------------------------------------------------------

const response = (content, extra = {}) => ({
  model: "deepseek-flash",
  choices: [{ finish_reason: "stop", message: { content, ...(extra.message ?? {}) } }],
  ...extra.top,
});

test("response checks: model, finish reason, tool calls, JSON", () => {
  const good = JSON.stringify({ status: "done", files: [{ path: "a.js", content: "x" }] });
  assert.equal(checkResponse(response(good), { expectedModel: "deepseek-flash" }).ok, true);
  assert.equal(checkResponse(response("```json\n" + good + "\n```"), { expectedModel: "deepseek-flash" }).ok, true);
  assert.equal(checkResponse(response(good), { expectedModel: "deepseek-v4-pro" }).code, "MODEL_MISMATCH");
  const length = response(good);
  length.choices[0].finish_reason = "length";
  assert.equal(checkResponse(length, { expectedModel: "deepseek-flash" }).code, "LENGTH");
  assert.equal(checkResponse(response(good, { message: { tool_calls: [{ id: "t" }] } }), {}).code, "TOOL_CALLS");
  assert.equal(checkResponse(response("not json"), {}).code, "JSON_INVALID");
  assert.equal(extractJson("```\n{}\n```"), "{}");
});

test("staging: allowlist, locked files, unsafe and duplicate paths, exact-once edits", () => {
  const files = { "quiz-core.js": "const a = 1;\nconst b = 2;\n", "dup.js": "x\nx\n" };
  const readFile = (p) => (p in files ? files[p] : null);
  const opts = { allow: ["quiz-core.js", "dup.js", "lib/**"], locked: ["test/accept.test.js"], readFile };

  const ok = stageArtifact({ status: "done", edits: [{ path: "quiz-core.js", old: "const b = 2;", new: "const b = 3;" }], files: [{ path: "lib/new.js", content: "n" }] }, opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.staged.get("quiz-core.js"), "const a = 1;\nconst b = 3;\n");
  assert.equal(ok.staged.get("lib/new.js"), "n");

  const code = (artifact) => stageArtifact(artifact, opts).code;
  assert.equal(code({ status: "done", files: [{ path: "other.js", content: "" }] }), "PATH_OUTSIDE_SCOPE");
  assert.equal(code({ status: "done", files: [{ path: "test/accept.test.js", content: "" }] }), "PATH_LOCKED");
  assert.equal(code({ status: "done", files: [{ path: "../x.js", content: "" }] }), "PATH_UNSAFE");
  assert.equal(code({ status: "done", files: [{ path: "lib/a.js", content: "" }, { path: "lib/a.js", content: "" }] }), "PATH_DUPLICATE");
  assert.equal(code({ status: "done", files: [{ path: "lib/a.js", content: "" }], edits: [{ path: "lib/a.js", old: "a", new: "b" }] }), "PATH_AMBIGUOUS");
  assert.equal(code({ status: "done", edits: [{ path: "dup.js", old: "x", new: "y" }] }), "EDIT_MATCH");
  assert.equal(code({ status: "done", edits: [{ path: "quiz-core.js", old: "nope", new: "y" }] }), "EDIT_MATCH");
  assert.equal(code({ status: "done", edits: [{ path: "lib/missing.js", old: "a", new: "b" }] }), "EDIT_MISSING_FILE");
  assert.equal(code({ status: "blocked", blockers: ["need decision"] }), "BLOCKED");
  assert.equal(code({ status: "done" }), "EMPTY");
  assert.equal(code({ status: "maybe" }), "SCHEMA");
});

test("staging: replacement text containing $ patterns is inserted literally", () => {
  const staged = stageArtifact(
    { status: "done", edits: [{ path: "a.js", old: "X", new: "$& $1 $$" }] },
    { allow: ["a.js"], readFile: () => "X" },
  );
  assert.equal(staged.staged.get("a.js"), "$& $1 $$");
});

// ---- guards --------------------------------------------------------------

const baseFacts = () => ({
  changedPaths: ["quiz-core.js", "test/accept.test.js"],
  addedLines: new Map([["quiz-core.js", ["const a = 1;"]], ["test/accept.test.js", ["test('[A1] x', () => {});"]]]),
  totals: { files: 2, lines: 10 },
  lockMismatches: [],
  baseTestCount: 100,
  testCount: 101,
  syntaxErrors: [],
  whitespaceErrors: "",
});
const ticket = { lane: "standard", writeScope: ["quiz-core.js"], harnessPaths: ["test/accept.test.js"], allow: [] };
const failedIds = (facts, t = ticket) => staticGuards(facts, t, config).filter((r) => !r.ok).map((r) => r.id);

test("guards: a clean change passes every static guard", () => {
  assert.deepEqual(failedIds(baseFacts()), []);
});

// Each case below would pass if its guard were removed, so each guard is load-bearing.
test("guards: every static guard fails on its own violation", () => {
  const cases = [
    ["locked-tests", (f) => { f.lockMismatches = ["test/accept.test.js"]; }],
    ["write-scope", (f) => { f.changedPaths.push("author.js"); }],
    ["protected-paths", (f) => { f.changedPaths.push("supabase/migrations/0040_x.sql"); }],
    ["no-test-weakening", (f) => { f.testCount = 99; }],
    ["no-test-weakening", (f) => { f.baseTestCount = null; }],
    ["no-test-weakening", (f) => { f.testCount = null; }],
    ["no-test-weakening", (f) => { f.addedLines.set("test/accept.test.js", ["test.skip('x', () => {})"]); }],
    ["no-test-weakening", (f) => { f.addedLines.set("test/accept.test.js", ["test('x', { skip: true }, () => {})"]); }],
    ["no-test-weakening", (f) => { f.addedLines.set("quiz-core.js", ["// eslint-disable-next-line no-undef"]); }],
    ["config-untouched", (f) => { f.changedPaths.push(".github/workflows/x.yml"); }],
    ["no-new-dependencies", (f) => { f.changedPaths.push("package-lock.json"); }],
    ["syntax", (f) => { f.syntaxErrors = ["quiz-core.js: SyntaxError"]; }],
    ["syntax", (f) => { f.whitespaceErrors = "quiz-core.js:3: trailing whitespace."; }],
    ["lane-limits", (f) => { f.totals = { files: 2, lines: 401 }; }],
    ["public-safety", (f) => { f.addedLines.set("quiz-core.js", ["const p = '/Users/someone/secret';"]); }],
    ["public-safety", (f) => { f.addedLines.set("quiz-core.js", ["const k = 'sk-abcdefghijklmnopqrstuvwxyz123';"]); }],
  ];
  for (const [id, mutate] of cases) {
    const facts = baseFacts();
    mutate(facts);
    assert.ok(failedIds(facts).includes(id), `${id} should fail`);
  }
});

test("guards: an unmeasured test count (pre-test pass) does not fail; an unknown one does", () => {
  const facts = baseFacts();
  facts.testCount = undefined;
  assert.deepEqual(failedIds(facts), []);
});

test("guards: skip options in product code are not test weakening; allowed extras pass", () => {
  const facts = baseFacts();
  facts.addedLines.set("quiz-core.js", ["const opts = { skip: true };"]);
  assert.deepEqual(failedIds(facts), []);
  const withConfig = baseFacts();
  withConfig.changedPaths.push("package.json");
  assert.deepEqual(failedIds(withConfig, { ...ticket, writeScope: ["quiz-core.js", "package.json"], allow: ["config", "deps"] }), []);
  const prot = baseFacts();
  prot.changedPaths.push("supabase/migrations/0040_x.sql");
  assert.deepEqual(failedIds(prot, { ...ticket, lane: "protected", writeScope: ["quiz-core.js", "supabase/migrations/**"] }), []);
});

test("guards: test guards and classification", () => {
  const green = testGuards({
    acceptanceStatusById: { A1: { found: 1, passed: 1, failed: 0, skipped: 0 } },
    regression: { exitCode: 0, counts: { tests: 10, pass: 10, fail: 0, cancelled: 0 } },
  });
  assert.ok(green.every((r) => r.ok));
  assert.ok(!testGuards({ acceptanceStatusById: {}, regression: { exitCode: 0, counts: { tests: 1, pass: 1, fail: 0 } } })[0].ok, "no cases is a failure");
  assert.ok(!testGuards({ acceptanceStatusById: { A1: { found: 1, passed: 1, failed: 0, skipped: 0 } }, regression: { exitCode: 1, counts: { tests: 1, pass: 0, fail: 1 } } })[1].ok);
  assert.ok(!testGuards({ acceptanceStatusById: { A1: { found: 1, passed: 1, failed: 0, skipped: 0 } }, regression: null })[1].ok);
  assert.equal(classify(green).outcome, "GREEN");
  assert.equal(classify([{ id: "protected-paths", ok: false }, { id: "syntax", ok: false }]).outcome, "PROMOTE_PROTECTED");
  assert.equal(classify([{ id: "lane-limits", ok: false }]).outcome, "PROMOTE_LANE");
  assert.equal(classify([{ id: "syntax", ok: false }]).outcome, "FAILED");
  assert.deepEqual(formatGuardLines([{ id: "x", ok: false, detail: "d" }]), ["FAIL x: d"]);
});

// ---- lock and config -----------------------------------------------------

test("acceptance lock detects edits and deletions", () => {
  const files = { "test/a.test.js": "one", "test/b.test.js": "two" };
  const lock = makeLock(Object.keys(files), (p) => files[p] ?? null);
  assert.equal(lock.files["test/a.test.js"], sha256("one"));
  assert.deepEqual(lockMismatches(lock, (p) => files[p] ?? null), []);
  files["test/a.test.js"] = "changed";
  delete files["test/b.test.js"];
  assert.deepEqual(lockMismatches(lock, (p) => files[p] ?? null), ["test/a.test.js", "test/b.test.js (missing)"]);
  assert.throws(() => makeLock(["nope"], () => null));
});

test("the committed harness config is valid and protects the harness itself", () => {
  assert.deepEqual(validateConfig(config), []);
  assert.ok(matchesAny("tools/delegate/run.mjs", config.protectedPaths));
  assert.ok(matchesAny("scripts/roadmap/lifecycle.mjs", config.protectedPaths));
  assert.ok(matchesAny(".env.local", config.protectedPaths));
  const broken = structuredClone(config);
  broken.deepseek.baseUrl = "http://api.deepseek.com";
  broken.ladder = [];
  assert.ok(validateConfig(broken).length >= 2);
});
