# Project operating playbook: GitHub Issues and Projects

Verified against official GitHub documentation on **2026-09-30**. This is a
copyable setup guide, not a second roadmap. It captures practices learned in
VERA without requiring a particular LLM, provider, editor, operating system,
session format, or agent framework.

## Start here

Copy this file into the new repository and give it to the assistant setting up
the project. Replace project-specific names and choose the routing profiles.
The assistant needs authorized GitHub read/write tools; repository automation
also needs file editing and command execution. A browser, API connector, or
GitHub CLI can perform setup. If a capability is missing, report the missing
step rather than claiming it happened.

Use native GitHub Issues and Projects first. Add a small lifecycle wrapper when
agents start operating concurrently; reuse a tested wrapper rather than building
a ticketing service. The `ready`, `claim`, `review`, and `complete` operations
below describe that wrapper's contract, **not built-in GitHub CLI commands**.

Completion means a sample issue can travel from Inbox through review to Done,
with dependencies, ownership, acceptance, and API-budget safeguards verified.
The setup test must use an explicitly designated test issue, not production work.

## 1. Establish authority, permissions, and the board

1. Create a repository and an issue-backed GitHub Project; link the repository.
   Choose visibility deliberately. Public tickets must contain no credentials,
   private recordings, customer data, or sensitive local filesystem paths.
2. Record repository identity, Project URL and number, owner type (user or
   organization), and durable specification/decision-document locations in a
   checked-in configuration file. Discover API node IDs and field/option IDs
   from this project; never copy another project's IDs.
3. Authenticate the intended account with the minimum permissions needed for
   the chosen tools. Inspect the installed CLI version and `--help` before
   relying on flags. For CLI setup, `gh auth status` and `gh --version` are
   useful checks; never print the token itself.
4. Create the fields below, then a board grouped by Status and a table showing
   dependencies, routing, ownership, size, and acceptance. Issue assignees and
   labels belong to the issue; Project-specific values belong to its item.
5. Inspect built-in workflows before adding work. Disable or adjust any rule
   that would mark implementation accepted merely because a PR merged or a
   field changed. If closed issues imply Done, ensure only the acceptance
   procedure can close them. Seed existing issues explicitly: auto-add does
   not backfill every existing match.

| Field | Suggested values / purpose |
| --- | --- |
| Status | Inbox, Backlog, Blocked, Ready, In progress, In review, Done |
| Priority | Owner-defined ordering; assistants preserve it unless authorized |
| Size | Small, Medium, Large, Unknown; report expected scope at launch |
| Workstream | Project-specific area, such as design, backend, integration |
| Acceptance | Automated, External, Producer |
| Assignee | Account responsible for the work; execution claim records the actual run |
| Routing labels | Exactly one `model:<profile>` and one `effort:<level>` before Ready |

The Project plus its linked issues owns live scope, status, dependencies,
priority, ownership, and routing. Specifications, accepted designs, contracts,
decisions, and historical evidence own their durable subjects. A generated
dashboard is a view of the Project, not another source of truth.

**Authentication gotchas:** classic PAT GraphQL reads can use `read:project`;
writes use `project`, while `gh project` documents the broader `project` scope.
GitHub Apps are another option. Fine-grained token support depends on the exact
endpoint and owner type; do not assume all Projects operations support it.
Actions' repository `GITHUB_TOKEN` cannot access Projects by itself. Environment
tokens can override CLI-stored credentials, so refreshing stored credentials
may not fix the token actually being used.
[Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects),
[Projects REST permissions](https://docs.github.com/en/rest/projects/projects),
[Actions authentication](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions),
[CLI authentication environment](https://cli.github.com/manual/gh_help_environment).

Project item IDs differ from issue IDs. Adding an issue and updating its
Project fields are separate operations. Confirm the returned item ID and field
option IDs before writing; never infer them from issue numbers or names alone.

Done when the authenticated tool can read the intended Project, the fields and
workflow settings are recorded, and an authorized test mutation is verified.
[Built-in workflows](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations),
[Auto-add behavior](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically).

## 2. Give each issue a bounded contract

Use this body in an issue template. Replace placeholders before Ready; `None`
is valid only when there really are no prerequisites. Keep the Dependencies
section machine-readable: one canonical entry per prerequisite, without prose.

```markdown
## Outcome
One observable result and why it matters.

## Scope
- Included work, affected modules, and required outputs.

## Exclusions
- Explicit boundaries, including adjacent work deferred elsewhere.

## Dependencies
Blocked by #123
Blocked by owner/repository#456

## Acceptance
Automated | External | Producer (choose one)
- [ ] Specific observable criterion.
- [ ] Focused regression checks and the repository validation gate pass.
- [ ] Retained evidence identifies the tested commit and reproduction steps.

## Verification
Exact commands or real-tool steps, expected results, and evidence locations.
For Producer acceptance: a short numbered checklist with what to inspect
and the exact acceptance response requested.

## Boundaries and authorization
Contract/fixture changes: None, or link the separately approved change note.
External inputs/services: None, or explicit privacy, retention, and cost policy.

## Starting baseline
Required branch/commit, or the normal integration branch.

## Routing and size rationale
Why the selected model profile, effort, and size fit this bounded task.
```

Parent/sub-issue hierarchy groups work; it does not establish execution order.
Use native blocked-by relationships when available and keep them consistent
with the canonical Dependencies section. Treat disagreements as blockers until
reconciled. Cross-repository prerequisites must name the repository, and the
configuration must identify each prerequisite's authoritative Project.
[Sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues),
[Issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies).

Search open **and closed** issues for semantic duplicates before creating work.
Create Inbox placeholders as future requirements become evident; mark unknown
scope honestly rather than making placeholders executable prematurely.

**Feasibility first:** identify assumptions that could invalidate the project
or an expensive design. Put bounded real-environment proofs before dependent
design/build work. A simulated contract test is not proof that an external
application supports the operation. Record constraints and fallbacks, then
make dependent work explicitly wait for accepted feasibility evidence.

Done when every executable issue has a complete contract, explicit acceptance,
and reconciled dependencies. Unresolved design or authorization stays Blocked
or Backlog; it does not become Ready because a parent ticket closed.

## 3. Define provider-neutral routing and acceptance

Use logical profiles, such as `model:economy`, `model:standard`, and
`model:advanced`, with a checked-in mapping to available provider/model IDs.
These names are examples, not a required taxonomy. Define allowed effort
levels and their runner-specific mapping in the same policy.

Choose the least expensive profile that safely fits the work. Authorization,
data-loss risks, and difficult cross-system state deserve stronger review.
Prefer current supported model generations within the approved profile unless
a recorded compatibility, capability, or reproducibility reason dictates
otherwise. Capture the exact model/version actually used in execution evidence.
Unsupported effort/model mappings must be resolved explicitly, not silently
translated. Change routing only with concrete escalation evidence: attempted
checks, failure, remaining risk, and the smallest next scope.

| Acceptance class | What permits completion |
| --- | --- |
| Automated | Authorized reviewer/automation verifies retained deterministic checks; no ritual human review of a large document |
| External | Verified evidence from the actual application/service/environment; simulation alone is insufficient |
| Producer | Explicit human acceptance of the exact artifact/version for visual, listening, workflow, or product judgment |

An implementation agent's self-report is evidence, not independent acceptance.
Keep manual review for things the owner could have a meaningful opinion about.
External evidence can be automated where the real tools permit; human judgment
still requires explicit acceptance. Large or uncertain issues should be split
when meaningful boundaries exist, rather than solved by routing alone.

Done when a tool can validate exactly one model label, one effort label, their
supported mapping, and the issue's acceptance authority before starting work.

## 4. Make lifecycle operations fail closed

Implement these checks in one shared, tested entry point. A connector or CLI
adapter may expose them differently, but should enforce the same policy.

- **Inspect:** targeted live issue/Project read, criteria, routing, dependencies,
  claim history, and integration baseline. Reports do not mutate state.
- **Ready:** re-read relevant live state; verify complete criteria and valid
  routing. Every prerequisite must be closed **and Done on its own roadmap**,
  with required acceptance recorded. Missing/incomplete data fails closed.
- **Claim:** recheck Ready and dependencies under the coordination mechanism;
  reject another live claim. Record repository/issue, actual execution ID,
  owner, branch, worktree, starting commit, and exact model/effort. Verify the
  execution ID is this run's, not an inherited parent environment value.
- **Block/escalate:** retain the cause and needed decision/evidence; preserve
  scope and owner priority. A routing change requires its justification.
- **Review:** record the tested commit, commands/results, artifact identities,
  exclusions, and outstanding acceptance steps. Keep judgment-dependent work
  In review until accepted.
- **Complete:** verify the appropriate acceptance, commit/push state, and
  availability on the required integration baseline; then close and mark Done.
  Accepted work on a special branch must name that branch/commit so dependent
  tasks cannot accidentally start from a baseline missing it.

Use one issue, one active execution, and one dedicated branch/worktree. Acquire
a shared coordination lock before live checks and hold it through claim writes.
A host-local lock covers only cooperating processes on that host. For multiple
hosts/independent connectors, use one authorized dispatcher or an actual shared
coordination mechanism. A comment plus a re-read is not an atomic claim.

Stale claims require evidence that the execution stopped; age alone is not
proof. Reconcile issue state, Project status, and claim records before restarting.
GitHub mutations are not a multi-field transaction: errors/timeouts can leave
some writes completed. Re-read and reconcile before replaying an operation,
especially comment creation. Use stable operation markers where appropriate.

Done when duplicate claims and unresolved dependencies are refused, acceptance
cannot be bypassed, and partial-write recovery has a tested path.

## 5. Protect the shared GitHub API budget

Rate limits are unavoidable; wasteful calls and uncoordinated retries are not.
Implement protection **before** many concurrent agents or dashboards use the
board. Route every repository-owned reader and writer through the same audited
transport boundary, including progress views, parent lookups, and schedulers.

### Distinguish the budgets

| Budget | Typical authenticated user limit | Counted unit |
| --- | --- | --- |
| REST primary | 5,000/hour | Requests; search and other resources have separate limits |
| GraphQL primary | 5,000/hour | Connection-based query points, minimum one |
| Secondary | Separate concurrency, request-point, CPU, and content limits | Not the remaining primary quota |

These are current ordinary-user defaults, not universal quotas or safe target
rates; credential/account types can differ. A GraphQL mutation request costs
**five secondary points**, not automatically five primary points. Nested
connections can make one query cost multiple primary points. Measure returned
`rateLimit.cost` and response headers rather than counting shell commands.
[GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api),
[REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

### Required transport behavior

1. Serialize cooperating operations with a shared lock; refuse lock contention
   before network calls. Record process identity and use conservative stale-lock
   recovery. A live owner must not lose the lock solely because it is old.
2. Before protected GraphQL work, obtain direct GraphQL quota evidence and
   reserve a conservative cost for the bounded operation plus a safety margin.
   Use current response headers and returned `rateLimit` data. VERA observed
   false-green REST `/rate_limit` GraphQL summaries; they must not authorize
   GraphQL work. REST operations need their own resource-budget checks.
3. Include `rateLimit { limit remaining used resetAt cost }` in targeted read
   queries where feasible; refresh the local budget from results. Count the
   preflight itself. Invalidate reservations on failures or uncertain responses.
4. Read only the issue, matching Project item, fields, recent claim comments,
   and declared prerequisites needed for the operation. Batch bounded dependency
   reads. Search older comment pages only when necessary to find claim history.
5. Page explicitly with cursors and progress checks. GraphQL connections accept
   page sizes 1–100. Bound total work and detect truncated nested connections;
   incomplete metadata cannot support Ready, claims, or completion.
6. Inspect GraphQL `errors` even on HTTP 200. Parse structured errors/headers;
   a ticket body containing the words "rate limit" is not an API throttle.
7. Respect `Retry-After` and primary reset times. Secondary throttles can occur
   while primary points remain; there is no secondary-quota status query.
   Report the next allowed attempt and stop the lifecycle operation rather than
   looping. Any configured read retry must be bounded and honor GitHub backoff;
   re-read state before retrying an uncertain write.
8. Pace mutations: GitHub recommends serial requests and at least one second
   between mutations. Poll on meaningful intervals; prefer supported webhooks
   when worthwhile. Cache read-only snapshots with visible timestamps/staleness;
   refresh live state before consequential transitions. Output filtering alone
   does not reduce server query cost.
9. Inventory all GitHub transports and add an automated bypass check. High-level
   CLI/connector calls can hide GraphQL lookups and pagination; one invocation
   is not one request. Keep sanitized diagnostic logs, never credentials.

GitHub currently documents a shared ceiling of 100 concurrent REST/GraphQL
requests and generally 80 content-generating requests/minute and 500/hour.
These are limits, not pacing targets, and lower/undisclosed secondary limits
exist. A local gate cannot control other tools or hosts using the same quota.
It reduces avoidable exhaustion; it cannot promise no throttling.
[API pacing and recovery](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api),
[Pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api),
[CLI API behavior](https://cli.github.com/manual/gh_api).

For diagnosis only, this explicit probe reports direct GraphQL evidence and
headers. It consumes quota; use the shared gate once available, not repeated
ungated health checks:

```sh
gh api graphql --include \
  -f query='query { rateLimit { limit remaining used resetAt cost } }'
```

Done when fake-transport tests prove primary exhaustion, secondary throttles,
HTTP-200 errors, missing quota data, pagination limits, and lock contention stop
before protected calls. Test bypass detection and recovery from partial writes
without deliberately exhausting GitHub or mutating production tickets.

## 6. Add a read-only progress view

Generate it from the Project through the shared gate. Show snapshot time,
Done/Remaining, status/workstream breakdowns, blocked reasons, size, routing,
and links to issues. Separate goals/parents from executable-work denominators;
avoid counting the same work twice. Display unknown size and placeholders.
Issue-count progress is not an estimate of effort or a delivery date.

Keep rendering local/read-only, throttle refreshes, and reuse a snapshot when
appropriate. Make partial fetches visible rather than calling them complete.
A launcher or browser link is useful; another hand-maintained status document
is not. Done when totals match the fetched board, freshness is clear, and the
view cannot write to GitHub or bypass the budget gate.

## 7. Make execution and recovery reproducible

- Pin runtimes and lock dependency versions. Bootstrap each new worktree with
  the repository's standard frozen-lockfile install; a package cache speeds
  this up but does not make an uninstalled worktree ready. Avoid sharing mutable
  installed dependency directories between active worktrees.
- Require approved change notes for frozen contracts, fixtures, generated types,
  goldens, or accepted tests: change, reason, compatibility, regeneration,
  migration, and acceptance impact. Preserve accepted design artifacts and
  identify successors explicitly.
- Retain exact commands, exit results, versions, tested commits, and artifact
  hashes. Keep sensitive inputs local unless an explicit per-run policy
  authorizes an external route, retention behavior, and cost ceiling.
- Use repository-local pre-command guards where the runner supports them,
  verify the assigned worktree, and test dangerous-command refusals without
  executing the commands. Hooks are runner adapters, not universal protection:
  unsupported tools, GUIs, indirect scripts, and human shells may bypass them.
  Add OS/tool permissions where available; document advisory-only environments.
- Recovery begins with read-only branch/HEAD/base/diff inventory and a human
  choice. Do not silently reset, clean, force-push, delete broad paths, or erase
  another task's work. A guard is not a sandbox or an independent backup.
- Record backup location, access/encryption, retention, owner, and a successful
  restore test before claiming backups exist. Git history, worktrees, and
  immutable application snapshots alone are not independent backups. VERA's
  command-guard work did **not** implement automated backups.

Done when a fresh worktree can reproduce checks, guards state their actual
coverage, and claimed recovery/backup capabilities have retained evidence.

## 8. Keep technical lessons and optional usage evidence

At meaningful milestones, capture reusable, evidence-backed lessons: the
problem in plain language, exact technical mechanism, reproduction/check,
limitations, and what to copy. Mark untested ideas Proposed. Keep a separate
bounded risk register for unresolved hard problems, with observed evidence,
the later-review question, and the condition that retires each risk. It is not
a shadow roadmap or automatic escalation to a particular model.

If the runner exposes usage, append final per-execution input, cached-input,
and output totals to completed issues, identifying the source and all included
runs. Cached input is a subset of input where the provider defines it that way;
do not add it twice. Avoid summing repeated cumulative snapshots. State whether
counts are observed or incomplete; never substitute account-wide usage, an
estimate, or the steward's review tokens. A runner without reliable usage logs
still works: mark usage unavailable. Metrics do not gate product acceptance.

Keep routine stewardship quiet when nothing meaningful changed. It can maintain
issue metadata within its authority; dispatching, changing goals, or accepting
producer judgments requires separate authorization. Review routing outcomes
periodically and propose evidence-backed policy adjustments rather than applying
them silently.

## Copyable instruction pointer

Add this to whichever repository instruction mechanism your assistant actually
loads, or include it explicitly in task prompts. A filename alone does not
guarantee every LLM tool will discover it.

> Before creating, promoting, claiming, reviewing, or completing roadmap work,
> read `docs/PROJECT_OPERATING_PLAYBOOK.md` and the project-specific roadmap
> configuration. Use the shared lifecycle/API entry point. Preserve live board
> authority, explicit dependencies, bounded scope, exact routing, acceptance,
> and private-data boundaries. Report missing capabilities or conflicting
> evidence instead of bypassing the gates.

## VERA evidence and adaptation checklist

This guide's policies are portable. VERA's scripts, labels, npm commands,
runner hooks, and host lock path need adaptation, not blind copying.

- [#23: corrected GraphQL accounting](https://github.com/mbelinkie/vera-script-to-timeline/issues/23)
  established direct GraphQL preflight and lifecycle coordination. The later
  [#30: shared gate for all readers](https://github.com/mbelinkie/vera-script-to-timeline/issues/30)
  covered the dashboard and other bypasses. Copying the earlier fix alone
  misses that protection.
- The accepted shared-gate reference is commit
  `bf1b215875ccbaf896c6fed822abf671690b14d9`:
  [reader inventory](https://github.com/mbelinkie/vera-script-to-timeline/blob/bf1b215875ccbaf896c6fed822abf671690b14d9/docs/roadmap-live-read-inventory.md)
  and [implementation plan/evidence](https://github.com/mbelinkie/vera-script-to-timeline/blob/bf1b215875ccbaf896c6fed822abf671690b14d9/docs/plans/shared-roadmap-read-gate.md).
  Its observed dashboard page cost was two primary points, not one. Its
  implementation deliberately added no automatic retry or cache; those are
  optional adaptations, not claims about implemented VERA behavior.
- Reference files in that commit are `scripts/roadmap-graphql-gate.mjs`,
  `scripts/roadmap-rate-limit.mjs`, `scripts/roadmap-lock.mjs`, the lifecycle
  caller, and the progress caller. Bring their refusal, entry-point, accounting,
  lock, and bypass tests with them. Remove hardcoded project/runtime assumptions
  only after identifying their purpose.
- Verify the target baseline contains the accepted implementation and its tests.
  Closed/Done tickets do not prove that the current checkout includes the code.
- [#132: worktree command safeguards](https://github.com/mbelinkie/vera-script-to-timeline/issues/132)
  provides a shared safety-script pattern with runner-specific adapters; verify
  hook loading and coverage in the new tool rather than promising enforcement.
- [#37: contract-change evidence](https://github.com/mbelinkie/vera-script-to-timeline/issues/37),
  [#42: sensitive-input boundaries](https://github.com/mbelinkie/vera-script-to-timeline/issues/42),
  and [#49: real-media validation](https://github.com/mbelinkie/vera-script-to-timeline/issues/49)
  supply examples, not requirements to copy private materials.
- [Primary-source review](investigations/github-project-setup-primary-sources-2026-09-30.md)
  retains the GitHub documentation checks, authentication caveats, and quota
  distinctions behind this revision. Recheck official docs when changing host,
  credential type, CLI version, or automation behavior.

**Final setup check:** correct Project and permissions; bounded issue template;
one supported route/effort; explicit dependencies; coordinated claims; verified
acceptance/integration; all transports gated; refusal tests passing; read-only
dashboard; reproducible worktree setup; truthful safety/backup coverage. If a
piece is not implemented, label it pending before launching concurrent agents.
