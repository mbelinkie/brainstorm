import { parseContract } from "../scripts/roadmap/lifecycle-core.mjs";

export const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const ISSUE_RANGE = { min: 13, max: 44 };

const priorityRank = (issue) => Object.hasOwn(PRIORITY_ORDER, issue.priority) ? PRIORITY_ORDER[issue.priority] : Infinity;

export function sortIssues(issues) {
  return [...issues].sort((a, b) => priorityRank(a) - priorityRank(b) || a.number - b.number);
}

const fieldValue = (section, name) => {
  const pattern = new RegExp(`^\\s*(?:[-*]\\s+)?${name}\\s*:\\s*(.*?)\\s*$`, "gim");
  const matches = [...section.matchAll(pattern)].map((match) => match[1].trim());
  return matches.length === 1 && matches[0] ? matches[0] : null;
};

function migrationDecision(value) {
  if (/^none\.?$/i.test(value)) return { allowed: true, allocation: null };

  const assignments = [
    /^assigned by Matthew\s*:?\s*(?:migration\s*)?#?(\d{4})\.?$/i,
    /^Matthew assigned\s+(?:migration\s*)?#?(\d{4})\.?$/i,
    /^migration\s+#?(\d{4})\s+assigned by Matthew\.?$/i,
  ];
  const assignment = assignments.map((pattern) => pattern.exec(value)).find(Boolean);
  if (assignment) return { allowed: true, allocation: assignment[1] };
  return { allowed: false, code: "MIGRATION_ASSIGNMENT_REQUIRED" };
}

// Ticket text is public input. Unknown scope or authorization syntax blocks
// selection; provisional migration ranges never count as an assignment.
export function assessIssueContract(body) {
  if (typeof body !== "string" || !body.trim()) return { allowed: false, code: "SCOPE_UNKNOWN" };

  const contract = parseContract(body);
  const scope = contract.sections.Scope;
  if (!scope || contract.problems.some((problem) => problem.section === "Scope")) {
    return { allowed: false, code: "SCOPE_UNKNOWN" };
  }

  const boundaries = contract.sections["Boundaries and authorization"];
  if (!boundaries || contract.problems.some((problem) => problem.section === "Boundaries and authorization")) {
    return { allowed: false, code: "AUTHORIZATION_UNKNOWN" };
  }

  const migrations = fieldValue(boundaries, "Migrations");
  const ownerDecisions = fieldValue(boundaries, "Owner decisions");
  if (!migrations || !ownerDecisions) return { allowed: false, code: "AUTHORIZATION_UNKNOWN" };

  const migration = migrationDecision(migrations);
  if (!migration.allowed) return { allowed: false, code: migration.code };
  if (!/^none\.?$/i.test(ownerDecisions)) {
    return {
      allowed: false,
      code: /^pending\b/i.test(ownerDecisions) ? "OWNER_DECISION_PENDING" : "OWNER_DECISION_UNRESOLVED",
    };
  }

  return { allowed: true, scope, migration: migration.allocation, ownerDecisions: "None" };
}

export function isFullCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
