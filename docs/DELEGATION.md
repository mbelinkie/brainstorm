# Delegated coding: process

Version 3, October 2, 2026. Replaces `docs/DEEPSEEK_CODING_GUIDE.md` (v1) and the v2 draft. This file is **project-agnostic**. A project supplies:

- a lifecycle adapter (here: [Working a ticket](roadmap/WORKING_A_TICKET.md));
- a routing table (here: [routing](roadmap/routing.md));
- role cards (here: [`docs/delegation/cards/`](delegation/cards/));
- a harness configuration (see [the harness spec](delegation/HARNESS_SPEC.md)).

**Who reads this file.** Sessions working a ticket do **not** read it. They read only their role card and the inputs the harness gives them. Read this file when changing the process, building the harness, or settling a dispute about what a card means.

## 1. What this process optimizes

**Goal:** the most tickets that are **accepted and stay closed**, per unit of Codex subscription allowance. DeepSeek spend is capped but secondary. Correctness is not traded away: a reopened ticket costs more allowance than a careful first pass.

**Where the allowance went in the October 1 batch.** We priced Codex's own usage report at GPT-6.1 Sol rates:

| Session | Approx. credits | Share |
| --- | --- | --- |
| The single long dispatcher conversation | ~1,000 | 85% |
| All coordinator, verifier and reviewer sessions for #15, #16 and #17 | ~180 | 15% |

The dispatcher re-read its whole growing history on every action, including while waiting on other sessions: 179M input tokens. Every session also started by reading about 165 KB of process docs. Mechanical work (applying artifacts, hashing, building checks, writing long evidence) was done by the most expensive model. Three rules follow from this, and everything below applies them:

1. **A script orchestrates; models only decide.** The dispatcher is the harness, not a conversation. The harness picks tickets, launches sessions, waits, applies artifacts, runs checks, writes evidence and merges. No model conversation ever waits, polls, or holds batch state.
2. **Sessions are short, small and single-purpose.** Each Codex session gets a role card (about 60 lines or fewer) plus a harness-written input of about 300 lines or fewer. It does one step, writes a decision, and ends. State lives in files.
3. **Use the cheapest model whose judgment is sufficient, and escalate on evidence.** DeepSeek does all reading, writing and repairing of code and tests. Luna makes routine decisions on harness-proven evidence. Sol handles protected work, escalations and audits.

---

## 2. Roles

| Role | Who | Model and effort | Codex allowance |
| --- | --- | --- | --- |
| **Harness** | Script ([spec](delegation/HARNESS_SPEC.md)) | None | None |
| Scout | DeepSeek, artifact-only | `deepseek-flash`, thinking `low` | None |
| Test author | DeepSeek, separate request from implementer | `deepseek-v4-pro`, `high` | None |
| Implementer | DeepSeek | Ladder, §5 step 5 | None |
| Mutant writer | DeepSeek | `deepseek-flash`, `low` | None |
| Pre-reviewer | DeepSeek, fresh request | `deepseek-v4-pro`, `high` | None |
| **Controller** | Codex session; holds the lifecycle claim in Express and Standard lanes | `gpt-6-luna`; actual effort per routing table | Low |
| **Verifier** | Separate Codex session (different execution ID) | `gpt-6-luna`, `medium` | Low |
| **Sol** | Codex session | `gpt-6.1-sol`, `high` | High: use sparingly |
| **Owner** | Matthew | — | — |

**Sol's work.**

- Designs Protected-lane tickets and holds their claim.
- Answers escalations.
- Audits a sample of Luna accepts (§10).
- Reviews harness changes once.

**DeepSeek's limits.**

- DeepSeek is **artifact-only**. It receives source text and a packet, and returns JSON artifacts. It gets no tools, shell, filesystem, Git, GitHub, network or credentials.
- The harness validates and applies every artifact (§8).
- No Codex model writes product code or fixes. The single exception is in the Controller card: an edit of 5 lines or fewer when that is cheaper than another repair cycle, with the harness rerunning all guards afterwards. The project's routing table may forbid even that.

---

## 3. Gate 0: is this ticket suited to this process?

This process is for **coding tickets whose done-state a runnable check can prove without a person looking at it.** Design work (layout, look and feel, copy tone, choosing between product approaches) and research work (investigate and report) are not suited. Neither is front-end work whose acceptance is visual judgment.

The fit check runs before any claim, cheapest source first:

1. **Labels (harness, free).** A label listed in `fitGate.flagLabels` (for example `type:design`, `type:research`) flags the ticket.
2. **Scout (DeepSeek, free).** Recon reports `work_type: coding | design | research | mixed` and `testable_done: yes | no`, with one line of reasoning.
3. **Controller (in triage, one word per ticket).** Confirms or overrides the classification.

**A flagged ticket is not claimed or worked.** The harness records a block with one question for the owner and moves on to the next eligible ticket; it never stalls the batch. The question offers three answers:

- **skip**: this ticket goes to an interactive Claude session instead;
- **run anyway**;
- **split**: design with Claude first, then file the decided behavior as testable coding tickets.

Tickets whose acceptance is owner sign-off (for example, Brainstorm's *Producer* class) are not automatically flagged. The Scout's `testable_done` answer decides. Such tickets still get a sign-off summary for the owner (§5 step 8).

---

## 4. Lanes

### Express

Tiny, low-risk tickets. DeepSeek does the whole ticket; Luna gates it with one bundle.

- **Typical tickets:** docs, comments, copy, test-only additions, lint fixes, a bug with an existing failing test or exact reproducer.
- **Limits:** about 60 changed lines or fewer; 3 files or fewer; no Protected paths; no new dependencies, schema, migration or public API change.

### Standard

The default lane: the full pipeline in §5.

### Protected

Sol designs the ticket, holds the claim and runs real-process checks (§9). DeepSeek may still implement pure sub-pieces under the Standard pipeline. Protected work includes:

- credentials, secrets and environment handoff;
- permissions, auth and access policy (row-level security (RLS), grants);
- destructive operations (cleanup, deletion, worktree removal, migrations, data rewrites);
- billing and metering;
- process lifecycle, recovery and concurrency;
- the delegation harness and lifecycle tooling themselves;
- anything the project lists in its protected-paths file.

### Promotion rules

The harness enforces these. A ticket never moves down a lane mid-ticket.

| Trigger | Result |
| --- | --- |
| A diff touches a protected path | Protected |
| A diff exceeds lane limits, adds a dependency, or changes test, CI or build configuration | Up one lane |
| The repair ladder hits its cap | Back to the Controller for REPAIR, ESCALATE or RECLAIM |
| A second ladder cap | Sol |
| An open question the Controller can't settle from the ticket | Sol |
| A category's reopen rate passes its threshold (§10) | The whole category moves up a lane |

---

## 5. The pipeline (Standard lane)

Each step lists who acts and the Codex cost. Steps 1–6 and 8 cost no Codex allowance.

### 1. Intake (harness)

1. Run the project's read-only planner and gates.
2. Run Gate 0 label checks.
3. Record the base SHA.
4. Create the worktree and install dependencies.
5. Create the private ticket directory.

### 2. Recon (Scout)

The harness assembles the input; DeepSeek has no tools. It sends:

- the ticket text;
- a repository map (paths plus top-level symbols);
- the full text of candidate files, found by path and keyword matches from the ticket, plus their direct importers.

The Scout returns `recon.json`:

- a summary;
- claims, each with a path, line range and **verbatim quote**;
- files to change, callers, the pattern to reuse, and a reproduction command;
- proposed acceptance cases (`given` → `expect`, kind normal, failure or invariant);
- open questions;
- `work_type`, `testable_done`, a suggested lane and risk flags;
- `contract_drift`: places where the ticket's contract disagrees with the current code.

The harness then:

- checks every quote against the file and line range. Mismatches become `unverified_claims`. If more than 20% fail, recon reruns on `deepseek-v4-pro`.
- runs the reproduction command.
- blocks the ticket if `contract_drift` is non-empty. The contract is outdated, and an agent must not improvise around it.

### 3. Triage (Controller, batched)

One Luna session receives a harness-trimmed view of up to 10 recon reports and returns one block per ticket:

```text
#<n>: fit=<ok|flag> lane=<express|standard|protected>
  decisions: <one line per open question, or ESCALATE>
  cases: approve A1,A2; edit A3 -> "<expect>"; add A4 "<given> -> <expect>"
```

The Controller does not open source files during triage. Anything it cannot decide from the view goes to Sol or Protected.

**Claim.** Once triage returns `fit=ok`, the harness launches the claimant: the Luna Controller for Express and Standard, Sol for Protected. The claimant runs the project's claim command with its own native ID. Recon is read-only. Nothing in the worktree changes before the claim succeeds.

### 4. Acceptance tests (test author + harness)

DeepSeek writes the approved cases as tests using the project's existing test tools. It also returns a one-line **case map** per test (`A1 → test name: asserts …`). The harness:

1. Runs them on the base SHA. Each must **fail with an assertion failure**: the JUnit outcome must be *failed*, not a load or syntax error. A test that passes on base, or fails for the wrong reason, goes back to the test author once, then to the Controller.
2. Records SHA-256 hashes of the acceptance files (the "lock") and the base test count.

### 5. Implement with the repair ladder (DeepSeek + harness)

The ladder is pre-authorized and every step is recorded. A recorded Flash-to-Pro step is a routing decision made by policy; it is not a silent replacement.

| Attempt | Model and effort | Input |
| --- | --- | --- |
| 1 | `deepseek-flash` high | Packet |
| 2 | `deepseek-flash` high | Packet, the current diff, and a failure excerpt of 40 lines or fewer |
| 3 | `deepseek-v4-pro` high | Fresh: packet, failure excerpt, and the previous diff marked "rejected" |
| 4 | `deepseek-v4-pro` max | As attempt 3 |

The harness applies each attempt's artifacts and then runs **every guard** (spec §5) and the tests. The ladder stops at the first fully green attempt. A guard failure counts as a failed attempt. The cap is 4. A capped run sends a short "capped" bundle to the Controller.

A response cut off by the output limit (`finish_reason: length`) is charged and logged but does **not** use up a ladder step. It is retried once with the same model and a larger output cap. A second cut-off means the slice is too large: it is split, and the split is recorded.

Tune the starting rung per category from the ledger (§10).

### 6. Mutant check and pre-review (DeepSeek + harness)

**Mutant check.** The mutant writer returns 2–3 plausible but wrong variants of the final change, inside the write scope (a dropped edge case, an off-by-one, a swallowed error). The harness applies each in a scratch copy and runs the acceptance tests.

- Every mutant must fail at least one test.
- If a mutant survives, the test author gets one round to strengthen the tests, which are then re-locked and rerun.
- If a mutant still survives, the bundle flags it.

**Pre-review.** A fresh request receives the packet, the cases, the invariants, the test code and the diff, with this instruction: *"List only concrete violations: broken invariant, caller not updated, changed error behavior, added side effect, out-of-scope edit, or a test that does not assert its approved case. Cite path:line. Output NONE if none."*

- Findings trigger one more implementer attempt.
- Remaining findings go into the bundle verbatim.
- The pre-reviewer filters; it never approves.

### 7. Gate (Controller)

The claimant Luna session reads the **review bundle** (spec §6) and its card, and decides:

| Decision | When and what happens |
| --- | --- |
| **ACCEPT** | All guards pass, all acceptance tests pass with none skipped, all mutants are killed, and the diff plausibly implements the approved cases with no collateral change. The harness publishes the branch and PR at the full SHA, and the Controller records the lifecycle review. |
| **REPAIR `<note of 5 lines or fewer>`** | The harness reruns from attempt 3 with the note. Allowed once per ticket. |
| **ESCALATE `<reason>`** | Sol gets the bundle and returns a decision file. The Controller then acts on it. |
| **RECLAIM** | Block the ticket for re-slicing or a Protected-lane redesign. Safe partial work is preserved. |

### 8. Verify and finish

1. A separate Luna Verifier session runs **one** harness command. It makes a clean detached checkout at the published SHA, installs dependencies, runs the full suite and the acceptance tests, and prints a summary of 30 lines or fewer. The Verifier compares that summary against the bundle and records the lifecycle `verify` with its own execution ID.
2. Verification happens **once, at the final published SHA.** Intermediate heads are checked by the harness, not by a Codex session.
3. For tickets the pipeline can complete (Brainstorm: *Automated*), the harness merges, preserving the verified SHA, runs the suite on the integrated main branch, and calls lifecycle `complete`.
4. Owner sign-off tickets (Brainstorm: *Producer*) stop at review. The harness writes a sign-off summary for the owner: what changed, how to look at it, and the exact acceptance wording requested.
5. The harness writes the ledger row and a short per-ticket evidence file. Sessions never read or write the shared worklog.

### Express lane differences

Express runs steps 1, 2 (optional), 5, 7 and 8. It has no mutant check or pre-review and no new acceptance tests unless the ticket requires them.

### Slicing

If a ticket is larger than one packet, the Scout proposes slices: one behavior, one main boundary, and about 1–3 production files per slice. The Controller approves them in triage. Dependent slices run in order. Independent slices may run in parallel only in separate worktrees with non-overlapping write scopes.

---

## 6. Budgets and circuit breakers

The harness enforces all limits. Configured values live in the harness config; tune them from the ledger.

| Limit | Default | When exceeded |
| --- | --- | --- |
| Codex tokens per Controller session | 300k input (cached included), 20k output | Stop the ticket and block it with the usage recorded |
| Codex tokens per Verifier session | 150k input, 8k output | Same |
| Codex tokens per Sol session | 1.5M input, 40k output | Same, and report to the owner |
| Codex sessions per ticket | Express 2, Standard 4, Protected 6 (escalations count) | Block |
| DeepSeek USD per batch | $10 observed spend | Stop launching. A request already in flight may finish |
| Batch deadline | 8 hours from a fresh start | Stop launching |
| Plan headroom (§7) | 5-hour usage under 80% before starting a ticket | Don't start or resume; wait for the reset, or use credits if the owner allowed them |
| Codex credits per batch (§7) | 0, unless the owner sets a cap | Pause until the plan window resets |

Rules:

- The harness reads token usage from each session's machine-readable output. A session whose usage is missing counts as **over budget**: missing usage is unknown, never zero.
- Only the harness may add a role, session or reviewer to a ticket. No session may spawn another.

---

## 7. One Codex account

The harness runs every Codex session on **one** ChatGPT account. It never
rotates sessions across several accounts to get past per-account limits.
OpenAI's Terms of Use prohibit circumventing "any rate limits or restrictions",
and a suspension would stop the whole process.

When the account nears its limits:

1. **Before starting a ticket,** the harness checks that the 5-hour window has
   room for the whole ticket (the §6 headroom threshold). If not, it waits for
   the reset instead of starting work it can't finish.
2. **Claimant threads simply wait.** A paused claimant resumes on the same
   account after the reset, so claim identity is never at risk.
3. **Weekly limit reached:** the batch stops and reports. Nothing waits for
   days.
4. **Credits (optional).** Plus and Pro accounts can buy extra Codex credits in
   ChatGPT under Settings → Usage, charged at the rate card and usable from the
   command-line tool. Only the owner buys them. If the owner sets a per-batch
   credit cap, the harness continues past the plan limit until it has spent
   that many credits, estimated from session usage at rate-card prices. Then
   it pauses. Whether Codex draws on credits automatically once the plan limit
   is hit is still to be confirmed.

The harness reads the account's 5-hour and weekly usage from the rate-limit
fields in Codex's own session output (spec §7). Missing usage counts as
exhausted.

## 8. DeepSeek: models, calls and artifacts

### Models

Official API `https://api.deepseek.com`, checked October 2, 2026. Prices are per million tokens, off-peak / peak.

| ID | Version | Cache hit | Cache miss | Output | Notes |
| --- | --- | --- | --- | --- | --- |
| `deepseek-flash` | V4.1 Flash | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 | Thinking or non-thinking, JSON, 1M context |
| `deepseek-v4-pro` | V4-Pro-0813 | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 | Thinking, JSON, 1M context |

- The legacy name `deepseek-v4-flash` is only temporarily routed. Use `deepseek-flash`.
- Thinking is on by default at `high`; the effort values are `low`, `high` and `max`.
- **Peak hours:** 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays. Daytime US Eastern is always off-peak.
- Check `/models` at batch start, and the returned model and fingerprint on every response.

### Request rules

- **Thinking slices:** `max_tokens` covers reasoning plus the answer. Use 65,536 for thinking slices; the maximum is 393,216.
- **Stable prefix first:** the worker prefix, byte-identical and versioned, then the repository conventions block (regenerated only when the base SHA changes), then the packet, then any failure excerpt. DeepSeek caches automatically on a best-effort basis; record `prompt_cache_hit_tokens`.
- **Record every response**, including failed ones: request ID, requested and returned model, fingerprint, thinking mode and effort, `max_tokens`, finish reason, usage and latency. Keep these in the private evidence directory.
- **Keep secrets out of requests.** The API key stays in the private request wrapper, outside the repository. Never send secret files (`.env*`, `.dev.vars`), private fixtures or private evidence to DeepSeek. For a private repository, decide once per project whether sending its source to DeepSeek is acceptable.

### Artifact contract

The model returns JSON only, in one of two forms:

```json
{"status":"done|blocked",
 "files":[{"path":"...","content":"<complete file>"}],
 "edits":[{"path":"...","old":"<exact text>","new":"<text>"}],
 "case_map":[{"case":"A1","test":"...","asserts":"..."}],
 "summary":"<=3 lines","blockers":["..."],"notes":["<=5 items"]}
```

Before writing anything, the harness validates the whole response:

- finish reason `stop`, the correct model, no tool calls, valid JSON and schema;
- every path inside the allowlist, with no duplicates;
- each `old` text matching exactly once.

It stages all edits in memory, applies them together, and then runs the guards. A truncated or invalid response is evidence only; none of it is applied. DeepSeek marks any checks it did not run as unrun, and its report is never acceptance evidence.

### Worker prefix (`worker-prefix.md`, version 3.0)

```text
worker-prefix v3.0
You implement a bounded change described in the packet that follows. You have
no tools; the harness applies your JSON and runs every check itself, so your
report is not evidence.

Read the supplied repository instructions, files, callers and the pattern to
reuse. Reuse existing helpers; add dependencies, configuration or scaffolding
only when the packet authorizes them. Match the packet's inputs, outputs,
errors and side effects exactly; preserve existing error behavior.

Acceptance tests are locked. Changing, skipping or weakening any test, or any
test/CI/build configuration, fails the attempt automatically. If a test looks
wrong, say so in "blockers" and stop.

If the root cause or a required change lies outside the write scope, or a rule
is ambiguous, return status "blocked" naming the paths or missing decision. No
placeholder stubs. Make the smallest complete change. Return only the JSON
artifact defined in the packet.
```

### Packet (generated by the harness)

```text
Ticket #<n>, slice <s>: <one observable behavior>
Lane: <lane>  Base: <full SHA>  Runtime: <language/framework versions>
Goal: <trigger/input> must produce <output/state>.
Files (verbatim below): <paths with verified line ranges>
Callers: <path:line>   Pattern to reuse: <path:start-end>
Write scope: <globs>   Allowed extras: <deps|config|none>
Contract: <signature/schema; valid/invalid inputs; outputs; errors; side effects>
Decisions: <one line each, from triage>
Invariants: <must hold after success, failure and retry>
Acceptance (locked): <test IDs, one line each>
Steps (only if ordering is contractual): <short pseudocode>
--- files ---
<verbatim file contents>
```

---

## 9. Protected-lane real-process checks

These are owned by Sol, carried over from v1. DeepSeek may implement the pure parts; Sol exercises the real boundary with disposable resources and synthetic credentials.

| Risk | DeepSeek may implement | Sol's real-process check |
| --- | --- | --- |
| Undercounted spend | Usage and cost calculation from supplied fixtures. Sol defines how failed attempts, retries and missing usage count | Feed real-shaped responses (success, billable failure, retry, absent usage) through the real path. Unknown usage never becomes zero |
| Wrong resume after interruption | A pure transition decision from Sol's table | Interrupt a disposable child, persist, restart, and observe the next action |
| Credentials restored to child processes | A pure environment filter from Sol's allowlist | Launch a real child through the real wrapper with allowed and forbidden sentinel variables, and inspect what it receives |
| Cleanup deleting others' work | A pure eligibility decision | In a temporary repo with owned and unrelated worktrees, run real cleanup and verify preservation and refusal |
| Access policy (RLS, grants) | SQL from Sol's policy table | Source checks plus the owner's privilege queries after application. Source checks alone are not proof |

---

## 10. Measurement and tuning

### Ledger

The harness writes one row per ticket:

- ticket, category, lane and final lane, fit result, base SHA;
- recon quote pass rate, ladder attempts, models used, DeepSeek cost and cache-hit ratio, mutants killed out of total;
- for each Codex session: role, model, effort, input / cached / output tokens, and whether it ran on plan allowance or credits;
- decisions, repairs, escalations;
- PR, merge time, and whether the ticket reopened within 14 days, with the cause.

### KPI

**Codex credits per ticket still closed after 14 days.** Weight tokens with the published rate card:

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| Luna | 2.5 | 0.25 | 12.5 |
| Sol | 50 | 2.5 | 250 |

Credits are per million tokens. Include rework and reopens. Track DeepSeek USD per kept ticket separately.

### Tuning rules

- **Sol audit.** Sol audits 1 in 5 Luna accepts after merge for the first 30, then 1 in 20, reading only the bundle and the diff. Defects Luna missed tighten its escalation triggers, or move that category to Sol review.
- **Reopens.** If a category's 14-day reopen rate passes 10% in Express or 5% in Standard over its last 10 tickets, promote the category one lane. After 20 tickets with no reopens, consider demoting it one lane.
- **Ladder start.** If Flash's first-attempt pass rate for a category is below about 30%, start that category at attempt 3.
- **Recon quality.** If recon quote verification averages under 90%, run recon on Pro.
- **Codex budgets.** Set them to about 1.5× the 80th-percentile usage after 20 tickets.

---

## 11. Transition

- **Live claims, open PRs and in-flight tickets** finish under the rules they started with. A process change never ends a claim.
- **The new process starts** when the harness exists and the owner starts a batch.
- **Rollout:**
  1. Build the harness from the spec, in Standard-lane slices.
  2. Sol reviews the harness once.
  3. Pilot 5 Express and 5 Standard tickets, with a Sol audit on every pilot accept.
  4. Review the ledger, then move to the steady-state audit rate.

## Sources

- DeepSeek: [pricing](https://api-docs.deepseek.com/quick_start/pricing), [changelog](https://api-docs.deepseek.com/updates), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [context caching](https://api-docs.deepseek.com/guides/kv_cache)
- OpenAI: [Codex models](https://learn.chatgpt.com/docs/models), [Codex rate card and plan limits](https://learn.chatgpt.com/docs/pricing)
- OpenAI: [Terms of Use](https://openai.com/policies/terms-of-use/), [credits for flexible usage](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans)
- Background research: [research/deepseek-workflows-2026-10-01.md](research/deepseek-workflows-2026-10-01.md), [roadmap/LESSONS.md](roadmap/LESSONS.md)
