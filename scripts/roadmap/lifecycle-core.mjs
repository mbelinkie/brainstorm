// Pure logic for the roadmap lifecycle wrapper (issue #3): no I/O, no GitHub.
// lifecycle.mjs does the reading and writing, always through gate.mjs.
//
// Everything here fails closed: text it cannot parse is a problem, not a pass.

export const REQUIRED_SECTIONS = [
  "Outcome",
  "Scope",
  "Exclusions",
  "Dependencies",
  "Acceptance",
  "Verification",
  "Boundaries and authorization",
  "Starting baseline",
  "Routing and size rationale",
];

// Whole-line placeholders copied from .github/ISSUE_TEMPLATE/work-contract.md and
// the playbook. A test keeps this list in step with the real template.
export const PLACEHOLDER_LINES = [
  "One observable result and why it matters.",
  "Included work, affected modules, and required outputs.",
  "Explicit boundaries, including adjacent work deferred elsewhere.",
  "Blocked by #123",
  "Blocked by owner/repository#456",
  "Automated | External | Producer (choose one)",
  "Specific observable criterion.",
  "Focused regression checks and `npm test` pass.",
  "Retained evidence identifies the tested commit and reproduction steps.",
  "Exact commands or real-tool steps, expected results, and evidence locations.",
  "For Producer acceptance: a short numbered checklist with what to inspect and the",
  "exact acceptance response requested.",
  "Contract/fixture changes: None, or link the separately approved change note.",
  "External inputs/services: None, or explicit privacy, retention, and cost policy.",
  "Migrations: None, or note that the migration number is assigned by Matthew.",
  "Required branch/commit, or `main`.",
  "Why the selected `model:` profile, `effort:` level, and Size fit this task.",
];

const UNFINISHED_WORD = /\b(?:TBD|TODO|FIXME)\b/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// The one environment variable the Claude Code runner sets to its own session id.
// Other runners need an adapter; the wrapper refuses rather than guessing.
export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
export const PARENT_SESSION_ENVS = ["CLAUDE_CODE_PARENT_SESSION_ID", "CLAUDE_PARENT_SESSION_ID"];

const problem = (code, message, extra = {}) => ({ code, message, ...extra });
const stripComments = (text) => String(text ?? "").replace(/<!--[\s\S]*?-->/g, "");

// "- [ ] text", "- text" and "text" are the same content for placeholder purposes.
export function normalizeLine(line) {
  return String(line).trim().replace(/^[-*]\s+(?:\[[ xX]\]\s+)?/, "").trim();
}

export function splitSections(body) {
  const sections = {};
  let current = null;
  for (const line of stripComments(body).split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([name, lines]) => [name, lines.join("\n").trim()]));
}

export function parseContract(body) {
  const sections = splitSections(body);
  const problems = [];
  for (const name of REQUIRED_SECTIONS) {
    const text = sections[name];
    if (text === undefined || text === "") {
      problems.push(problem("CONTRACT_SECTION_MISSING", `contract section "${name}" is missing or empty`, { section: name }));
      continue;
    }
    const lines = text.split("\n").map(normalizeLine).filter(Boolean);
    const leftovers = lines.filter((line) => PLACEHOLDER_LINES.includes(line) || UNFINISHED_WORD.test(line));
    if (leftovers.length > 0) {
      problems.push(problem("CONTRACT_PLACEHOLDER", `section "${name}" still has placeholder text: "${leftovers[0]}"`, { section: name }));
    }
  }
  return { sections, problems };
}

// Exactly one of the configured classes, alone on the first line of the section.
export function parseAcceptanceClass(sectionText, classes) {
  const first = String(sectionText ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  if (first && classes.includes(first)) return { ok: true, value: first };
  return { ok: false, value: null, message: `the Acceptance section must start with exactly one of ${classes.join(", ")} (found "${first ?? ""}")` };
}

// Dependencies must be one canonical entry per line, or "None". Anything else is
// prose, which is not machine-readable and therefore not trusted.
export function parseDependencies(text, thisRepo) {
  const lines = stripComments(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, message: "the Dependencies section is empty" };
  if (lines.length === 1 && /^none$/i.test(lines[0])) return { ok: true, refs: [] };
  const refs = [];
  for (const line of lines) {
    const match = /^Blocked by (?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)$/.exec(line);
    if (!match) return { ok: false, message: `cannot parse Dependencies line "${line}" (use "Blocked by #N", "Blocked by owner/repo#N", or "None")` };
    refs.push(`${match[1] ?? thisRepo}#${match[2]}`);
  }
  return { ok: true, refs: [...new Set(refs)] };
}

export function splitRef(ref) {
  const [repo, number] = ref.split("#");
  return { repo, number: Number(number) };
}

export function isRepoName(value) {
  return REPO_NAME.test(value);
}

// Exactly one model: and one effort: label, both defined, and a supported pair.
export function evaluateRouting(labels, routing) {
  const problems = [];
  const modelLabels = labels.filter((l) => l.startsWith("model:"));
  const effortLabels = labels.filter((l) => l.startsWith("effort:"));
  let profile = null;
  let effort = null;
  if (modelLabels.length !== 1) {
    problems.push(problem("MODEL_LABEL_COUNT", `exactly one model: label is required (found ${modelLabels.length})`));
  } else {
    profile = modelLabels[0].slice("model:".length);
    if (!routing.profiles[profile]) {
      problems.push(problem("MODEL_LABEL_UNKNOWN", `model:${profile} is not a defined profile (${Object.keys(routing.profiles).join(", ")})`));
      profile = null;
    }
  }
  if (effortLabels.length !== 1) {
    problems.push(problem("EFFORT_LABEL_COUNT", `exactly one effort: label is required (found ${effortLabels.length})`));
  } else {
    effort = effortLabels[0].slice("effort:".length);
    if (!routing.efforts.includes(effort)) {
      problems.push(problem("EFFORT_LABEL_UNKNOWN", `effort:${effort} is not a defined effort (${routing.efforts.join(", ")})`));
      effort = null;
    }
  }
  if (profile && effort && !routing.profiles[profile].efforts.includes(effort)) {
    problems.push(problem("ROUTING_UNSUPPORTED", `model:${profile} does not support effort:${effort}; resolve it explicitly, it is never translated silently`));
  }
  return { profile, effort, escalation: labels.includes(routing.escalation.label), problems };
}

// ---- claims ---------------------------------------------------------------

const MARKER = /^\s*<!--\s*(claim|complete|release|block):v1\s+issue=(\d+)\s*-->/;

// Claims from anyone count as live (fail closed). Only a comment by a trusted
// author may END a claim, so a stranger on a public issue cannot release it.
export function parseClaims(comments, issueNumber, { endAuthors = null } = {}) {
  const claims = [];
  let live = null;
  (comments ?? []).forEach((comment, index) => {
    const marker = MARKER.exec(comment.body ?? "");
    if (!marker || Number(marker[2]) !== Number(issueNumber)) return;
    const kind = marker[1];
    if (kind === "claim") {
      const line = /^.*Execution ID:.*$/m.exec(comment.body)?.[0] ?? "";
      const executionId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(line)?.[0]?.toLowerCase() ?? null;
      const claim = { commentId: comment.id, executionId, index, createdAt: comment.createdAt };
      claims.push(claim);
      live = claim;
    } else if (kind === "complete" || kind === "release") {
      const login = comment.author?.login;
      if (!endAuthors || endAuthors.includes(login)) live = null;
    }
  });
  return { claims, live };
}

// True when a trusted-author comment carries the completion record for `issueNumber`.
export function hasCompletionRecord(comments, issueNumber, trustedAuthors) {
  return (comments ?? []).some((comment) => {
    const marker = MARKER.exec(comment.body ?? "");
    return marker && marker[1] === "complete" && Number(marker[2]) === Number(issueNumber)
      && (!trustedAuthors || trustedAuthors.includes(comment.author?.login));
  });
}

// ---- execution id ---------------------------------------------------------

// The id must be stated explicitly (--execution-id) AND agree with the id the
// runner put in this process's own environment. A child that merely inherits the
// environment never states an id, and one that copies its parent's is caught by
// the parent-session variables. Honest limit: a runner that exposes no parent
// variable cannot be told apart from its parent by this check.
export function resolveExecutionId({ flag, env = {} }) {
  const refuse = (code, message) => ({ ok: false, code, message });
  if (Array.isArray(flag)) return refuse("EXECUTION_ID_CONFLICT", "--execution-id was given more than once");
  const stated = typeof flag === "string" ? flag.trim() : "";
  const own = String(env[SESSION_ID_ENV] ?? "").trim();
  if (!stated) return refuse("EXECUTION_ID_MISSING", "state this run's id with --execution-id; it is never guessed");
  if (!own) return refuse("EXECUTION_ID_MISSING", `${SESSION_ID_ENV} is not set, so this run's own id cannot be verified`);
  if (stated.toLowerCase() !== own.toLowerCase()) {
    return refuse("EXECUTION_ID_CONFLICT", `--execution-id does not match this run's own ${SESSION_ID_ENV}`);
  }
  if (!UUID.test(stated)) return refuse("EXECUTION_ID_INVALID", "the execution id is not a UUID");
  for (const name of PARENT_SESSION_ENVS) {
    if (String(env[name] ?? "").trim().toLowerCase() === stated.toLowerCase()) {
      return refuse("EXECUTION_ID_INHERITED", `the execution id equals ${name}; it was inherited from a parent run, not this run's own`);
    }
  }
  return { ok: true, executionId: stated.toLowerCase() };
}

// ---- comments -------------------------------------------------------------

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

export function renderClaimComment({ repo, number, executionId, owner, model, effort, labels, startCommit, branch, worktree, mismatch, nowIso, baselineOid }) {
  const lines = [
    `<!-- claim:v1 issue=${number} -->`,
    "**Claim** (lifecycle wrapper; Ready gates re-checked under the lock)",
    "",
    `- Repository / issue: ${repo} #${number}`,
    `- Execution ID: \`${executionId}\``,
    `- Owner: ${owner}; executed by the run above`,
    `- Model / effort: \`${model}\` / effort \`${effort}\`; labels \`${labels.model}\` / \`${labels.effort}\``,
    `- Starting commit: \`${startCommit}\` (integration baseline seen: \`${baselineOid ?? "unknown"}\`)`,
    `- Working branch: \`${branch}\`; worktree: ${worktree}`,
    `- Claimed at: ${nowIso}`,
  ];
  if (mismatch) lines.push(`- Routing mismatch accepted: ${oneLine(mismatch)}`);
  return `${lines.join("\n")}\n`;
}

export function renderBlockComment({ number, cause, needs, executionId, routingChange, justification, approvedBy, nowIso }) {
  const lines = [
    `<!-- block:v1 issue=${number} -->`,
    "**Blocked**",
    "",
    `- Cause: ${oneLine(cause)}`,
    `- Needed decision or evidence: ${oneLine(needs)}`,
  ];
  if (executionId) lines.push(`- Execution ID: \`${executionId}\``);
  if (routingChange) {
    lines.push(
      `- Routing change proposed: \`${routingChange}\` (labels are changed by the owner, not by the wrapper)`,
      `  - Attempted checks and results: ${oneLine(justification.attemptedChecks)}`,
      `  - Failure: ${oneLine(justification.failure)}`,
      `  - Remaining risk: ${oneLine(justification.remainingRisk)}`,
      `  - Smallest next scope: ${oneLine(justification.nextScope)}`,
    );
    if (approvedBy) lines.push(`  - Owner go-ahead: ${oneLine(approvedBy)}`);
  }
  lines.push("- Scope, priority, size and routing labels are unchanged.", `- Recorded at: ${nowIso}`);
  return `${lines.join("\n")}\n`;
}

export function latestBlockCause(comments, issueNumber) {
  let cause = null;
  for (const comment of comments ?? []) {
    const marker = MARKER.exec(comment.body ?? "");
    if (marker && marker[1] === "block" && Number(marker[2]) === Number(issueNumber)) {
      cause = /^- Cause: (.*)$/m.exec(comment.body)?.[1]?.trim() ?? null;
    }
  }
  return cause;
}

export { oneLine };
