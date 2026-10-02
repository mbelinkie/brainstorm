import test from "node:test";
import assert from "node:assert/strict";
import { ticketTerms, exportedSymbols, selectContext, verifyClaims, validateRecon, validateTriage } from "../tools/delegate/core/recon.mjs";
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
