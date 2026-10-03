// Packets and role-session inputs, rendered from harness state. Pure.

const fence = (path, content) => `=== ${path} ===\n${content}\n=== end ${path} ===`;

export function renderFiles(files) {
  return files.map((f) => fence(f.path, f.content)).join("\n\n");
}

export function renderWorkerPacket({ ticket, title, lane, baseSha, runtime, goal, contract, decisions = [], cases = [], scope, allow = [], acceptanceFiles = [], callers = [], pattern = null, files = [], note = null, previous = null }) {
  return [
    `Ticket #${ticket}: ${title}`,
    `Lane: ${lane}  Base: ${baseSha}  Runtime: ${runtime}`,
    `Goal: ${goal}`,
    "",
    `Write scope (globs): ${scope.join(", ")}`,
    `Allowed extras: ${allow.length ? allow.join(", ") : "none"}`,
    `Locked acceptance files (read-only): ${acceptanceFiles.join(", ") || "none"}`,
    "",
    "Contract (from the issue):",
    contract,
    "",
    "Decisions:",
    ...(decisions.length ? decisions.map((d) => `- ${d}`) : ["- none"]),
    "",
    "Acceptance cases (each has a locked test named with its [ID]):",
    ...(cases.length ? cases.map((c) => `- [${c.id}] ${c.given ?? ""} -> ${c.expect}`) : ["- none; the full regression suite must stay green"]),
    "",
    callers.length ? `Callers: ${callers.join(", ")}` : "",
    pattern ? `Pattern to reuse: ${pattern}` : "",
    note ? `\nController note for this repair:\n${note}` : "",
    previous?.diff ? `\nYour previous attempt (rejected) as a diff against the files below:\n${previous.diff.split("\n").slice(0, 200).join("\n")}` : "",
    "",
    'Return ONLY JSON: {"status":"done|blocked","files":[{"path","content"}],"edits":[{"path","old","new"}],"summary":"<=3 lines","blockers":[],"notes":[]}',
    "Every edit's old text must match the current file exactly once. Use files[] for new files or full rewrites.",
    "",
    "--- files (current contents) ---",
    renderFiles(files),
  ].filter((line) => line !== "").join("\n");
}

export function renderTestAuthorPacket({ ticket, title, cases, acceptancePath, files, exampleTest, contract, problems = [], survivors = [], currentTests = null }) {
  return [
    `Ticket #${ticket}: ${title}`,
    `Write the acceptance tests for these approved cases into exactly one new file: ${acceptancePath}`,
    "",
    "Rules:",
    "- Use node:test and node:assert/strict, like the example test below. No new dependencies, no live services, no network.",
    "- One test per case, named with its ID in brackets first, e.g. test(\"[A1] rejects an empty answer\", ...).",
    "- The file must LOAD on the current code: statically import only modules that exist today. For a function that does not exist yet,",
    "  import the module namespace (import * as mod from ...) and assert on mod.fn so the test FAILS BY ASSERTION, not by a load error.",
    "  For a module that does not exist yet, import it inside the test: const mod = await import(\"../x.js\").catch(() => ({}));",
    "- Each test must fail on the current code because the behavior is missing, and pass once it is implemented.",
    "- Assert the observable behavior in the case, not implementation details. No skip, todo or only.",
    problems.length ? `\nYour previous tests were rejected:\n${problems.map((p) => `- ${p}`).join("\n")}` : "",
    survivors.length ? `\nSTRENGTHEN the existing tests below: these wrong implementations still pass them, so add or sharpen assertions until each one fails, while the correct implementation (in the source files) still passes:\n${survivors.map((m) => `- ${m.name}: ${m.mistake ?? ""}\n${m.edits.map((e) => `  in ${e.path}: replace ${JSON.stringify(e.old.slice(0, 200))} with ${JSON.stringify(e.new.slice(0, 200))}`).join("\n")}`).join("\n")}` : "",
    currentTests ? `\n--- current acceptance tests (${acceptancePath}) ---\n${currentTests}` : "",
    "",
    "Contract (from the issue):",
    contract,
    "",
    "Approved cases:",
    ...cases.map((c) => `- [${c.id}] (${c.kind ?? "normal"}) ${c.given ?? ""} -> ${c.expect}`),
    "",
    'Return ONLY JSON: {"status":"done","files":[{"path":"' + acceptancePath + '","content":"..."}],"case_map":[{"case":"A1","test":"<test name>","asserts":"<one line>"}],"summary":"<=3 lines"}',
    "",
    "--- example test from this repository ---",
    exampleTest,
    "",
    "--- source files (current contents) ---",
    renderFiles(files),
  ].filter((line) => line !== "").join("\n");
}

export function renderScoutPacket({ ticket, title, body, map, files }) {
  return [
    `Ticket #${ticket}: ${title}`,
    "",
    "Issue text:",
    body,
    "",
    "Return ONLY this JSON (no prose):",
    '{"ticket":<n>,"summary":"current vs requested behavior, one paragraph",',
    ' "claims":[{"claim":"...","path":"...","start":<line>,"end":<line>,"quote":"exact text from those lines"}],',
    ' "files_to_change":["path"],"callers":["path:line"],"pattern_to_reuse":"path:start-end or null",',
    ' "proposed_cases":[{"id":"A1","kind":"normal|failure|invariant","given":"...","expect":"..."}],',
    ' "open_questions":["..."],"work_type":"coding|design|research|mixed","testable_done":"yes|no",',
    ' "testable_reason":"one line","suggested_lane":"express|standard|protected","risk_flags":["..."],',
    ' "contract_drift":["places where the issue contract contradicts a supplied file (quote both); not things the files omit"],',
    ' "slices":null or [{"id":"S1","goal":"one behavior","scope":["paths"],"cases":["A1"]}]}',
    "Propose slices only when the ticket needs more than one bounded change: one behavior and about 1-3 production files each, in dependency order; every case in exactly one slice.",
    "",
    "Quotes are checked mechanically against the files: copy them exactly. Line numbers are 1-based.",
    "Protected work (migrations, RLS/grants, credentials, destructive operations, billing, lifecycle/harness, recovery) -> suggested_lane protected.",
    "Design, visual judgment or research -> work_type design/research and testable_done no.",
    "",
    "--- repository map ---",
    map,
    "",
    "--- candidate files (current contents, with line numbers) ---",
    files.map((f) => `=== ${f.path} ===\n${f.content.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")}`).join("\n\n"),
  ].join("\n");
}

// The text a Codex role session receives on stdin.
export function renderSessionInput({ card, step, body, commands = [], reply }) {
  return [
    `Read your role card first: ${card}`,
    "Do not read any other process document. Everything this step needs is below.",
    "",
    `## Step: ${step}`,
    "",
    body,
    commands.length ? "\n## Commands (run exactly as written; your shell already has your own CODEX_THREAD_ID)\n" : "",
    ...commands.map((c) => "```bash\n" + c + "\n```"),
    "",
    "## Reply",
    `End your turn with one fenced JSON object: ${reply}`,
  ].join("\n");
}

export function renderMutantPacket({ ticket, title, cases, scope, lockedFiles, files, count = 3 }) {
  return [
    `Ticket #${ticket}: ${title}`,
    `Write ${count} plausible but WRONG variants of the current implementation below.`,
    `Each variant is a list of exact edits inside the write scope (${scope.join(", ")}). Never edit: ${lockedFiles.join(", ") || "test files"}.`,
    "",
    "The approved behavior the tests should protect:",
    ...cases.map((c) => `- [${c.id}] ${c.given ?? ""} -> ${c.expect}`),
    "",
    'Return ONLY JSON: {"mutants":[{"name":"short-kebab-name","mistake":"one line","edits":[{"path","old","new"}]}]}',
    "Every old text must match the current file exactly once.",
    "",
    "--- current files ---",
    renderFiles(files),
  ].join("\n");
}

export function renderPreReviewPacket({ ticket, title, contract, decisions = [], cases, caseMap = [], scope, tests, diff }) {
  return [
    `Ticket #${ticket}: ${title}`,
    `Write scope: ${scope.join(", ")}`,
    "",
    "Contract (from the issue):",
    contract,
    "",
    "Decisions:",
    ...(decisions.length ? decisions.map((d) => `- ${d}`) : ["- none"]),
    "",
    "Approved acceptance cases:",
    ...cases.map((c) => `- [${c.id}] ${c.given ?? ""} -> ${c.expect}`),
    "Case map from the test author:",
    ...(caseMap.length ? caseMap.map((m) => `- ${m.case} -> ${m.test}: asserts ${m.asserts}`) : ["- none"]),
    "",
    'Return ONLY JSON: {"findings":[{"path":"...","line":<n>,"issue":"one concrete violation"}]}  (empty list if none)',
    "",
    "--- acceptance tests ---",
    tests,
    "",
    "--- diff under review ---",
    diff,
  ].join("\n");
}
