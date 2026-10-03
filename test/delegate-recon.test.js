import test from "node:test";
import assert from "node:assert/strict";
import { ticketTerms, exportedSymbols, selectContext, verifyClaims, validateRecon, validateTriage, contractText, referencedFiles } from "../tools/delegate/core/recon.mjs";
import { renderSessionInput, renderWorkerPacket } from "../tools/delegate/core/packet.mjs";
import { shellQuote } from "../tools/delegate/exec.mjs";

const FILES = {
  "quiz-core.js": "export function scoreAnswer(a) {\n  return a ? 1 : 0;\n}\nexport const VERSION = 1;\n",
  "room-api.js": 'import { scoreAnswer } from "./quiz-core.js";\nexport { scoreAnswer };\n',
  "author.js": "const unrelated = true;\n",
  ".env.local": "SECRET=1\n",
  "test/quiz-core.test.js": "import x from '../quiz-core.js';\n",
};
const read = (p) => FILES[p] ?? null;

test("recon context: ticket terms, exported symbols, matches plus importers, secrets excluded", () => {
  assert.ok(ticketTerms("Fix `scoreAnswer` so partial credit works").includes("scoreAnswer"));
  assert.deepEqual(exportedSymbols(FILES["quiz-core.js"]), ["scoreAnswer", "VERSION"]);
  const ctx = selectContext({ files: Object.keys(FILES), ticketText: "scoreAnswer returns wrong credit", readFile: read, excludes: [".env*"] });
  const chosen = ctx.chosen.map((c) => c.path);
  assert.ok(chosen.includes("quiz-core.js"));
  assert.ok(chosen.includes("room-api.js"));
  assert.ok(!chosen.includes(".env.local") && !ctx.map.includes(".env.local"), "secret files never reach DeepSeek");
  assert.ok(!chosen.includes("author.js"));
  assert.match(ctx.map, /quiz-core\.js: scoreAnswer, VERSION/);
});

// Pilot regression (issue #44): the template's process sections matched the
// roadmap tooling, the spec named by "Source:" was missed, and the Scout
// reported missing context as contract drift.
const ISSUE_44 = [
  "## Outcome", "Non-Kaplan events can use the image model through OpenRouter.",
  "## Scope", "- `ENGINES.openrouter` per base spec section 7.4, with fixtures.",
  "## Acceptance", "Automated", "- [ ] buildRequests and parseResponses covered from fixtures, including usage.cost.", "- [ ] `npm test` passes (real output pasted) and the tested commit ID is recorded.",
  "## Boundaries and authorization", "Dispatch authorization: Matthew authorized promotion of eligible implementation tickets; production deployment boundaries remain.",
  "## Routing and size rationale", "`model:standard` / `effort:medium` / Small.",
  "Source: docs/specs/architecture.md (and the base design).",
].join("\n");

test("recon context: process sections and template words are not search terms", () => {
  const text = contractText(ISSUE_44);
  assert.ok(!/Dispatch|Routing|## /.test(text), "process sections and headings dropped");
  assert.match(text, /ENGINES\.openrouter/);
  const terms = ticketTerms(text);
  for (const t of ["ENGINES.openrouter", "buildRequests", "parseResponses", "usage.cost"]) assert.ok(terms.includes(t), t);
  for (const t of ["npm test", "Outcome", "Automated", "authorization", "model:standard"]) assert.ok(!terms.includes(t), t);
});

test("recon context: named files, one hop through named documents, distinctive terms beat boilerplate", () => {
  const files = {
    "docs/specs/architecture.md": "Corrections to `design.md` section 7.4. `image-engine.js` is pure. See `quiz.sample.json`.",
    "docs/specs/design.md": "OpenRouter returns usage: { cost }.",
    "image-engine.js": "export const ENGINES = { kaplan_proxy: { buildRequests() {}, parseResponses() {} } };\n",
    "test/image-engine-kaplan.test.js": "import { ENGINES } from '../image-engine.js';\nENGINES.kaplan_proxy.buildRequests(); ENGINES.kaplan_proxy.parseResponses();\n",
    "quiz.sample.json": "{}",
    "docs/PLAYBOOK.md": "## Outcome\nAutomated acceptance, npm test passes, authorization, Dispatch, eligible implementation tickets, production deployment.\n",
  };
  for (let i = 0; i < 30; i += 1) files[`docs/notes-${i}.md`] = "adapter fixtures\n";
  const ctx = selectContext({ files: Object.keys(files), ticketText: ISSUE_44, readFile: (p) => files[p] ?? null });
  const chosen = ctx.chosen.map((c) => c.path);
  assert.equal(ctx.chosen[0].reason, "named in the ticket");
  for (const f of ["docs/specs/architecture.md", "docs/specs/design.md", "image-engine.js", "test/image-engine-kaplan.test.js"]) assert.ok(chosen.includes(f), f);
  assert.ok(!chosen.includes("quiz.sample.json"), "fixtures a document mentions in passing are not pulled in");
  assert.ok(!chosen.includes("docs/PLAYBOOK.md"), "template boilerplate does not select process documents");
  assert.ok(!chosen.some((f) => f.startsWith("docs/notes-")), "terms most files contain carry no weight");
});

test("referenced files: full paths and unique basenames only", () => {
  const files = ["docs/a/spec.md", "image-engine.js", "a/config.json", "b/config.json"];
  assert.deepEqual(referencedFiles("see docs/a/spec.md, `image-engine.js` and config.json", files).sort(), ["docs/a/spec.md", "image-engine.js"]);
});

test("recon quotes are checked against the real file and line range", () => {
  const claims = [
    { claim: "ok", path: "quiz-core.js", start: 1, end: 3, quote: "return a ? 1 : 0;" },
    { claim: "whitespace-insensitive", path: "quiz-core.js", start: 2, end: 2, quote: "  return   a ? 1 : 0;" },
    { claim: "wrong range", path: "quiz-core.js", start: 4, end: 4, quote: "return a ? 1 : 0;" },
    { claim: "invented", path: "quiz-core.js", start: 1, end: 3, quote: "return a * 2;" },
    { claim: "missing file", path: "nope.js", start: 1, end: 1, quote: "x" },
    { claim: "escape", path: "../etc/passwd", start: 1, end: 1, quote: "root" },
  ];
  const v = verifyClaims(claims, read);
  assert.deepEqual(v.verified.map((c) => c.claim), ["ok", "whitespace-insensitive"]);
  assert.equal(v.unverified.length, 4);
});

const goodRecon = () => ({
  summary: "s", claims: [], files_to_change: ["quiz-core.js"], callers: [], proposed_cases: [{ id: "A1", given: "g", expect: "e" }],
  open_questions: [], risk_flags: [], contract_drift: [], work_type: "coding", testable_done: "yes", suggested_lane: "standard",
});

test("recon shape validation", () => {
  assert.deepEqual(validateRecon(goodRecon()), []);
  assert.ok(validateRecon({ ...goodRecon(), work_type: "vibes" }).length);
  assert.ok(validateRecon({ ...goodRecon(), files_to_change: ["/etc/x"] }).length);
  assert.ok(validateRecon({ ...goodRecon(), proposed_cases: [{ id: "first", expect: "e" }] }).length);
  assert.ok(validateRecon(null).length);
});

test("triage validation: fit, lane, cases, scope; whole-repo scopes are refused", () => {
  const t = { n: 21, fit: "ok", lane: "standard", cases: [{ id: "A1", expect: "x" }], scope: ["quiz-core.js"] };
  assert.equal(validateTriage({ tickets: [t] }, [21]).ok, true);
  assert.equal(validateTriage({ tickets: [{ n: 21, fit: "flag" }] }, [21]).ok, true, "a flagged ticket needs nothing else");
  assert.equal(validateTriage({ tickets: [] }, [21]).ok, false);
  for (const scope of [["**"], ["**/*"], ["*.js"], []]) assert.equal(validateTriage({ tickets: [{ ...t, scope }] }, [21]).ok, false, JSON.stringify(scope));
  assert.equal(validateTriage({ tickets: [{ ...t, scope: ["../x"] }] }, [21]).ok, false);
  assert.equal(validateTriage({ tickets: [{ ...t, cases: [] }] }, [21]).ok, false, "standard needs a case");
  assert.equal(validateTriage({ tickets: [{ ...t, lane: "express", cases: [] }] }, [21]).ok, true);
  assert.equal(validateTriage({ tickets: [{ ...t, allow: ["everything"] }] }, [21]).ok, false);
});

test("session input and packets: card first, commands verbatim, quoting is shell-safe", () => {
  const input = renderSessionInput({ card: "docs/delegation/cards/controller.md", step: "gate", body: "B", commands: ["echo 'x'"], reply: "{}" });
  assert.ok(input.startsWith("Read your role card first: docs/delegation/cards/controller.md"));
  assert.match(input, /## Step: gate/);
  assert.match(input, /```bash\necho 'x'\n```/);
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  const packet = renderWorkerPacket({ ticket: 1, title: "T", lane: "standard", baseSha: "b", runtime: "Node", goal: "g", contract: "c", scope: ["a.js"], acceptanceFiles: ["test/x.test.js"], files: [{ path: "a.js", content: "x" }], cases: [{ id: "A1", given: "g", expect: "e" }] });
  assert.match(packet, /Write scope \(globs\): a\.js/);
  assert.match(packet, /Locked acceptance files \(read-only\): test\/x\.test\.js/);
  assert.match(packet, /=== a\.js ===\nx\n=== end a\.js ===/);
});
