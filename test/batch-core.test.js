import test from "node:test";
import assert from "node:assert/strict";
import { assessIssueContract, isFullCommitSha, ISSUE_RANGE, sortIssues } from "../tools/batch-core.mjs";

function body({ scope = "Update the presenter state recovery path.", migrations = "None", owner = "None" } = {}) {
  return `## Outcome
The observable behavior is corrected.
## Scope
${scope}
## Exclusions
No adjacent features.
## Dependencies
None
## Acceptance
Automated
- [ ] The regression test passes.
## Verification
1. Run npm test.
## Boundaries and authorization
Contract/fixture changes: None.
External inputs/services: None.
Migrations: ${migrations}
Owner decisions: ${owner}
## Starting baseline
main
## Routing and size rationale
model:standard / effort:high / Medium.`;
}

test("planner priorities sort P0 through P3, then issue number", () => {
  assert.deepEqual(sortIssues([
    { number: 14, priority: "P2" },
    { number: 17, priority: "P0" },
    { number: 15, priority: "P0" },
    { number: 13, priority: "P3" },
  ]).map((issue) => issue.number), [15, 17, 14, 13]);
});

test("a complete contract with no migration or owner decision is plannable", () => {
  assert.deepEqual(assessIssueContract(body()), {
    allowed: true,
    scope: "Update the presenter state recovery path.",
    migration: null,
    ownerDecisions: "None",
  });
});

test("owner decisions pending and non-empty unknown decisions block selection", () => {
  assert.equal(assessIssueContract(body({ owner: "Pending: confirm the source of truth." })).code, "OWNER_DECISION_PENDING");
  assert.equal(assessIssueContract(body({ owner: "Matthew chose option B." })).code, "OWNER_DECISION_UNRESOLVED");
});

test("a migration needs one concrete number explicitly assigned by Matthew", () => {
  assert.deepEqual(assessIssueContract(body({ migrations: "Migration 0042 assigned by Matthew." })), {
    allowed: true,
    scope: "Update the presenter state recovery path.",
    migration: "0042",
    ownerDecisions: "None",
  });
  assert.equal(assessIssueContract(body({ migrations: "Assigned by Matthew: migration #0042" })).migration, "0042");
  assert.equal(assessIssueContract(body({ migrations: "0042" })).code, "MIGRATION_ASSIGNMENT_REQUIRED");
  assert.equal(assessIssueContract(body({ migrations: "not assigned by Matthew — 0042" })).code, "MIGRATION_ASSIGNMENT_REQUIRED");
  assert.equal(assessIssueContract(body({ migrations: "Matthew assigned 0042, possibly 0043" })).code, "MIGRATION_ASSIGNMENT_REQUIRED");
  assert.equal(assessIssueContract(body({ migrations: "Matthew assigned migration 0042 provisionally" })).code, "MIGRATION_ASSIGNMENT_REQUIRED");
  assert.equal(assessIssueContract(body({ migrations: "0037+ (provisional; Matthew will assign later)" })).code, "MIGRATION_ASSIGNMENT_REQUIRED");
});

test("unknown scope, missing authorization labels, and placeholders fail closed", () => {
  assert.equal(assessIssueContract(null).code, "SCOPE_UNKNOWN");
  assert.equal(assessIssueContract(body({ scope: "Included work, affected modules, and required outputs." })).code, "SCOPE_UNKNOWN");
  assert.equal(assessIssueContract(body().replace("Owner decisions: None\n", "")).code, "AUTHORIZATION_UNKNOWN");
});

test("baseline identity is accepted only as a full 40-character SHA", () => {
  assert.equal(isFullCommitSha("cd15757cd7ffa0adadb91325a9613d99c9975f2d"), true);
  assert.equal(isFullCommitSha("cd15757"), false);
  assert.equal(isFullCommitSha("cd15757cd7ffa0adadb91325a9613d99c9975f2g"), false);
  assert.equal(ISSUE_RANGE.min, 13);
  assert.equal(ISSUE_RANGE.max, 44);
});
