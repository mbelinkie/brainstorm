// Pure parser for the JUnit XML that `node --test --test-reporter=junit` writes.
//
// Each <testcase> becomes { name, status, assertion, message } where status is
// passed | failed | skipped | todo. `assertion` is true only when the failure
// came from node:assert (ERR_ASSERTION / AssertionError); a file that fails to
// load is reported by node as a failed testcase named after the file, without
// an assertion, so "failed for the right reason" can be told apart from
// "did not load".

const decode = (text) =>
  String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function attr(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]) : null;
}

export function parseJunit(xml) {
  const text = String(xml ?? "");
  const cases = [];
  const suiteStack = [];
  // Attribute values may contain an unescaped ">" (node escapes only "<"), so
  // tags are matched attribute-aware.
  const TAG = String.raw`(?:[^>"]|"[^"]*")*`;
  const token = new RegExp(String.raw`<testsuite\b${TAG}>|<\/testsuite>|<testcase\b${TAG}\/>|<testcase\b${TAG}>([\s\S]*?)<\/testcase>`, "g");
  let match;
  while ((match = token.exec(text))) {
    const tag = match[0];
    if (tag.startsWith("<testsuite")) {
      if (!tag.endsWith("/>")) suiteStack.push(attr(tag, "name") ?? "");
      continue;
    }
    if (tag === "</testsuite>") {
      suiteStack.pop();
      continue;
    }
    const open = new RegExp(String.raw`<testcase\b${TAG}>`).exec(tag)[0];
    const inner = match[1] ?? "";
    const name = attr(open, "name") ?? "";
    let status = "passed";
    let message = "";
    const skipped = new RegExp(String.raw`<skipped\b${TAG}>`).exec(inner);
    if (skipped) status = attr(skipped[0], "type") === "todo" ? "todo" : "skipped";
    const failure = new RegExp(String.raw`<failure\b${TAG}>([\s\S]*?)<\/failure>|<failure\b${TAG}\/>`).exec(inner);
    if (failure || attr(open, "failure") !== null) {
      status = "failed";
      message = attr(failure?.[0] ?? open, "message") ?? attr(open, "failure") ?? "";
    }
    const body = decode(inner);
    const assertion = status === "failed" && /ERR_ASSERTION|AssertionError/.test(body);
    cases.push({ name, suite: suiteStack.join(" > "), status, assertion, message: message.slice(0, 300) });
  }
  const count = (status) => cases.filter((c) => c.status === status).length;
  const comment = (key) => {
    const m = new RegExp(`<!--\\s*${key}\\s+(\\d+)\\s*-->`).exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    cases,
    counts: {
      tests: comment("tests") ?? cases.length,
      pass: comment("pass") ?? count("passed"),
      fail: comment("fail") ?? count("failed"),
      skipped: comment("skipped") ?? count("skipped"),
      todo: comment("todo") ?? count("todo"),
      cancelled: comment("cancelled") ?? 0,
    },
  };
}

// Acceptance test names carry their case ID in brackets, e.g. "[A1] rejects ...".
export function caseIdOf(name) {
  const match = /\[([A-Z][A-Z0-9]{0,3}\d+)\]/.exec(String(name ?? ""));
  return match ? match[1] : null;
}

// Map caseId -> list of statuses for the acceptance cases found in a run.
export function acceptanceStatus(parsed, caseIds) {
  const result = {};
  for (const id of caseIds) result[id] = { found: 0, passed: 0, failed: 0, skipped: 0, assertionFailures: 0, otherFailures: 0 };
  for (const c of parsed.cases) {
    const id = caseIdOf(c.name);
    if (!id || !result[id]) continue;
    const r = result[id];
    r.found += 1;
    if (c.status === "passed") r.passed += 1;
    else if (c.status === "failed") {
      r.failed += 1;
      if (c.assertion) r.assertionFailures += 1;
      else r.otherFailures += 1;
    } else r.skipped += 1;
  }
  return result;
}

// Every approved case is present and every test for it passed; none skipped.
export function acceptancePassed(statusById) {
  const problems = [];
  for (const [id, r] of Object.entries(statusById)) {
    if (r.found === 0) problems.push(`${id} missing`);
    else if (r.skipped > 0) problems.push(`${id} skipped`);
    else if (r.failed > 0) problems.push(`${id} failed`);
  }
  return { ok: problems.length === 0, problems };
}

// Red-on-base: every approved case is present and fails by assertion only.
export function failsForTheRightReason(statusById) {
  const problems = [];
  for (const [id, r] of Object.entries(statusById)) {
    if (r.found === 0) problems.push(`${id} missing`);
    else if (r.passed > 0) problems.push(`${id} passes on base`);
    else if (r.skipped > 0) problems.push(`${id} skipped`);
    else if (r.otherFailures > 0) problems.push(`${id} fails without an assertion (load or runtime error)`);
  }
  return { ok: problems.length === 0, problems };
}
