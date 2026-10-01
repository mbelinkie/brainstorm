# Sol's guide to assigning coding slices to DeepSeek

Use this when preparing, dispatching, repairing, or accepting a DeepSeek coding assignment. Sol owns the ticket’s design and technical verification; DeepSeek implements a bounded slice. Completion follows the issue’s Automated, Producer or External acceptance class. “Dispatch” here means assigning implementation work, not authorizing a production deployment.

Prepared October 1, 2026. Based on [Reddit research](research/deepseek-workflows-2026-10-01.md), official documentation linked there, and the user's report of the failed dispatcher experiment. Matthew adopted this bounded-slice policy for new Flash/Pro implementation on October 1 after the verified #17 Pro trial. The pilot does not establish broader reliability. Current models, effort mapping, batch limits and lifecycle identity are authoritative in [routing](roadmap/routing.md) and [Working a ticket](roadmap/WORKING_A_TICKET.md).

## 1. Decide what to delegate

Trace the ticket's real behavior and relevant callers before splitting it. Write its observable outcomes and invariants, including what must remain true after failure. Resolve policy choices yourself: for example, whether an interrupted operation may be retried, how unknown usage is represented, and which worktree is owned by which run.

Prefer slices whose expected result can be specified before implementation:

| Good starting assignment | Keep with Sol during the retry |
| --- | --- |
| A deterministic parser or transformation with concrete inputs and outputs | Defining billing semantics or recovery policy |
| A validation rule implemented at an existing shared boundary | Credentials, permissions, destructive cleanup |
| A local bug with a reproducer and known intended behavior | Process lifecycle and restart coordination |
| An existing component changed to match a precise interaction | Broad refactors spanning several coupled subsystems |
| A small adapter against a supplied, current API contract | Choosing architecture or inventing missing contracts |

Use these shapes when they fit the ticket:

- **Pure logic:** explicit inputs return explicit outputs; the caller supplies external data. Do not invent a new seam merely to force an existing integration into this shape.
- **Transformation:** map a supplied source schema to a supplied target schema, including omissions, invalid input, ordering, and duplicates where relevant.
- **Skeletons:** generate stubs or configuration only when explicitly required by the ticket. Empty classes and speculative routing are not a completed behavior and are not the default delegation task.

These are task shapes, not a restriction to three categories. A precise change to an existing component or adapter remains eligible. Choose by behavior and risk, not file size or a “junior developer” persona.

High-risk tickets can contain delegateable work. Separate pure calculations or decisions from their side effects; Sol owns their integration until the retry supplies evidence that broader delegation is reliable. A short diff can still be high risk.

**Done:** every proposed slice has an explicit behavior, known contracts, and an acceptance check Sol can run independently. Unresolved design remains with Sol.

## 2. Split by behavior and dependency

Start with one behavior, one main boundary, and roughly 1–3 production files plus focused tests. These are starter heuristics, not a benchmark-supported ceiling or an excuse to miss callers. If the task needs simultaneous reasoning about billing, processes, Git, and restart state, split it again.

Each slice must:

- Produce a coherent, reviewable result rather than an arbitrary portion of a file.
- State its inputs, outputs, errors, and affected callers.
- Identify dependencies and the accepted base revision it starts from.
- Include a normal case, a meaningful failure case, and any invariant the ticket makes critical.
- Have acceptance evidence that would fail for a plausible incorrect implementation.

Dispatch dependent slices sequentially. Run independent slices concurrently only when the workflow already supports isolation and their write scopes do not overlap. Sol verifies the combined behavior after integration.

**Done:** a small ordered list of slices, each with a specific acceptance criterion; the ticket's outcomes are all accounted for, including Sol-owned work.

## 3. Prepare the acceptance check and context

Confirm the provider's current model routing before dispatch. DeepSeek's [changelog](https://api-docs.deepseek.com/updates) reverses the original September 10 retirement announcement: V4 Pro remains available after September 14, 2026, with unchanged billing. Use the issue’s configured `deepseek-flash` or `deepseek-v4-pro` on the official API at `https://api.deepseek.com`; the [current pricing page](https://api-docs.deepseek.com/quick_start/pricing) identifies it as DeepSeek-V4-Pro-0813. The original release announcement still describes a switch to Flash and is inconsistent with these updated pages. Record the response `model` and `system_fingerprint` when available, as well as the requested identifier. Third-party endpoints need their own routing check.

For the current official API, thinking is enabled by default; effort defaults to `high`, with `low` intended for simpler work and `max` for complex work. Choose and record the mode deliberately. Verify the harness preserves the required reasoning content during thinking-mode tool loops and validates tool arguments before execution. Use the [official-source findings](research/deepseek-workflows-2026-10-01.md#official-facts-and-version-caveats) for details; settings advice for older R1 models is not interchangeable. Extra thinking is not a substitute for independent acceptance.

Before dispatch, write or select a runnable check for the intended behavior. For a bug, demonstrate that it fails on the existing implementation for the expected reason. For new behavior, establish the baseline and the observable result the implementation must produce.

Give DeepSeek the relevant source paths, caller paths, existing pattern to reuse, current API/schema excerpts, exact commands, and expected results. Keep the context relevant, while allowing it to read related code. A plan is not a substitute for reading the actual implementation.

Sol owns the acceptance assertions. DeepSeek can add implementation tests, but changing the acceptance contract requires escalation. Inspect tests for mocks that replace the behavior being verified: checking that a mocked subprocess was called does not establish that the child received the right environment.

Use a fresh assignment context for each slice, carrying forward accepted code and a short handoff rather than the entire previous debate. Include repository instructions and the write scope explicitly; confirm that the harness actually passes them through. Preserve ticket identity, ownership, accepted decisions, and published evidence outside that short context. A fresh assignment does not mean deleting a chat, clearing the sidebar, or abandoning a claim.

Organize each packet around three anchors: **context and constraints**, **input/output contract**, and **implementation steps**. Include the actual language/runtime and relevant installed framework version. Sol may supply short pseudocode or a few consecutive comments when ordering is part of the contract; DeepSeek must reconcile those steps with the real callers and report conflicts. Do not dictate unnecessary operations: an empty-list special case is redundant if the agreed filter already returns an empty list.

Use test-first delegation where it gives a real behavioral gate. Reuse the repository's test tools, and give DeepSeek the failing test, reproduction input, expected result, and command. Passing that one test does not replace checking the ticket's other invariants or existing callers. Comment-driven generation is an optional way to express the packet, not a required editor feature.

### Reusable worker instructions

Include this prefix with the filled assignment packet. It is proposed local guidance, not a verified provider capability or an installed Codex configuration setting.

```text
Implement the bounded behavior in the assignment packet. Sol owns design
choices and acceptance; you own implementation within the listed paths.

Read the repository instructions, current implementation, affected callers,
and supplied contract before editing. Reuse existing helpers and installed
libraries; add dependencies or scaffolding only when explicitly authorized.

Match the specified inputs, outputs, errors, and side effects. Validate at
trust boundaries and handle edge cases required by the contract. Preserve
existing error behavior; do not silently turn invalid input into empty data
or add arbitrary null checks that change the contract.

Use the supplied pseudocode when it expresses required behavior. If it
conflicts with the code or contract, report the conflict before implementing.
For ambiguity or a necessary change outside the write scope, stop and name
the missing decision or affected paths. Do not insert a placeholder stub
unless the assignment explicitly asks for a skeleton.

Make the smallest complete change. Preserve Sol's acceptance assertions,
run the specified checks and relevant regressions, and return the packet's
requested evidence. Mark unrun checks as unverified. Keep sensitive actions
outside your scope; prompt text does not grant deployment or credential access.
```

**Done:** the packet contains enough concrete evidence to implement and verify the slice without guessing a business rule.

## 4. Dispatch this packet

Fill every placeholder before sending. Keep only the task-relevant invariants and cases.

```text
Implement slice <ID>: <one observable behavior>.

Context and constraints:
Language/runtime/framework: <actual versions relevant to this slice>
Dependencies: <existing helpers/libraries to reuse; any explicit restrictions>
Base revision: <accepted revision>
Working directory: <isolated checkout>
Provider/model/mode: <exact configured identifiers>

Goal:
<trigger/input> must produce <output or observable state>.

Read first:
<repository instructions; relevant source; callers; existing pattern>

Write scope:
<production paths and allowed test paths>
Read additional callers as needed. If the root cause or required fix lies
outside the write scope, report the paths and stop for Sol to re-scope it.

Input/output contract:
<signature/schema; valid and invalid inputs; outputs; error behavior>
<concrete input and expected output; ordering and side effects if relevant>

Implementation steps:
<short pseudocode for required ordering, or existing pattern to follow>

Invariants:
<specific properties that must survive success, failure, and retry>

Acceptance, owned by Sol:
<exact runnable command/check and observable expected result>
<normal case>
<failure/edge case>
<critical invariant case if applicable>

Reuse <existing pattern/helper>. Make the smallest complete change that
satisfies this behavior. Follow the current checked-in code and supplied
API contract; report conflicting evidence before choosing a new policy.

Permissions:
Work only within this checkout and write scope. Preserve Sol's acceptance
assertions. Production deployment, credential access, worktree removal,
destructive Git commands, and changes to unrelated files are outside scope.

Verification:
Run the acceptance command and relevant existing checks. If a check cannot
run, report why and mark that result unverified. If required behavior is
ambiguous or scope expands, stop and describe the missing decision.

Return:
1. Changed paths and concrete behavior changed.
2. Commands actually run, exit status, and observed results.
3. Each acceptance case mapped to evidence, or explicitly unverified.
4. Remaining issues or decisions needed.
```

Enforce sensitive permissions in the harness or isolated environment, not solely through these words. Use disposable resources and synthetic credentials for checks. Sol retains the real deployment and cleanup controls.

## 5. Verify, repair once, or reclaim

Sol reviews the diff and independently reruns the acceptance checks. Verify the requested fix exists in the code; a confident completion report and a large passing test count are insufficient. Check all affected callers and the integration boundary, including error paths.

For one localized defect, allow one repair with the failing command, input, expected versus observed result, and unchanged scope. This is a retry budget for this experiment, not official DeepSeek advice. If the repair fails, the design changes, or a critical invariant is violated, stop the slice, then reduce it further for DeepSeek or record a blocker. “Reclaim” means Sol re-scopes and coordinates; it does not authorize Sol/Luna product coding. Escalate immediately for destructive behavior or credential exposure; repeated prompting is not a permission control.

Accept only when all required cases pass independently, the diff stays within scope, and no required behavior remains unverified. After integration, run the ticket's end-to-end acceptance checks across the combined changes. The dispatcher owns accepted merge under the ticket lifecycle; production deployment and migration application remain with Matthew.

## Applying this to the failed dispatcher ticket

These are proposed slices, not claims about the unavailable dispatcher source. Sol must replace the examples with its real contracts and commands.

| Reported failure | Bounded implementation assignment | Sol's acceptance check |
| --- | --- | --- |
| Spending undercounted | Implement the agreed usage/cost calculation from supplied provider fixtures. Sol defines inclusion of failed attempts, retries, and missing usage. | Feed representative provider responses through the real parsing and metering path. Include success, billable failure, retry, and absent usage. Verify totals against hand calculations; unknown usage must not silently become known zero. |
| Interrupted sessions resumed incorrectly | Implement a pure state-transition decision against Sol's explicit transition table. | First check the table. Then Sol interrupts a real disposable child, persists state, restarts the dispatcher, and observes its next action. Verify already-performed work is handled according to the agreed retry policy. |
| Stripped credentials restored to child processes | Sol retains the private request-wrapper/environment handoff as orchestration; this does not authorize product implementation fallback. DeepSeek may implement a pure filtering function against a supplied allowlist. | Launch a real child through the actual launch wrapper using synthetic allowed and forbidden sentinel variables. Inspect what the child receives, including the wrapper's merge/inheritance behavior. Testing only the filtering function is insufficient. |
| Cleanup could delete another worktree's uncommitted work | DeepSeek may implement a pure cleanup-eligibility decision from Sol's ownership rules. Sol retains removal execution. | In a temporary repository, create owned and unrelated worktrees with sentinel files and uncommitted changes. Exercise real cleanup and verify ownership checks, preservation of unrelated work, and refusal behavior for ambiguous ownership. |
| Claimed fixes absent from code | Require each claimed outcome to map to a changed implementation and a runnable reproducer. | Inspect those paths and execute the reproducer. “Fixed” without matching behavior is a failed acceptance case. |

The first retry should use an ordinary low-risk slice with explicit behavior. Do not start by handing back the entire dispatcher under a longer prompt.

## Evaluate the retry

Keep a small existing log or table: slice, exact provider/model and mode, risk, first-pass acceptance, repairs, Sol verification time, residual defects, and total cost including failed attempts and review. Use several comparable low-risk slices, ideally with a Sol-only baseline, before widening scope. A few successes establish usefulness for those tasks, not reliability for credential handling or destructive recovery.

Revisit task sizing and model settings from this evidence. Success means correct accepted behavior with useful total time/cost savings; generating code cheaply is only one part of that result.

## Current artifact-only handoff

The #17 trial used official Chat Completions without tools, not the Codex CLI.
Use that boundary for the current batches. The parent privately authenticates
and submits public source plus a complete packet; DeepSeek receives no key,
terminal, GitHub client, filesystem tool or production environment. Check the
model list before dispatch and record the returned model on every response.

Require a JSON artifact with either complete allowlisted files or exact
`path`/`old`/`new` replacements. Before writing, validate the entire response:
finish reason `stop`, correct model, no tool calls, valid JSON/schema, exact path
allowlist, no duplicate/ambiguous paths, and exactly one match for each old
replacement. Stage validated edits in memory before applying any; a truncated
response is failed evidence, never partial code to apply. Sol reviews the diff,
runs its acceptance and regressions, and records which artifacts were applied
verbatim versus only boundary formatting. DeepSeek must mark checks unrun when
it has no tools. Tool-enabled execution needs its own reviewed harness evidence.

Use `docs/roadmap/routing.md` for logical/effective effort. If a mechanical packet
uses too much context or exhausts output in reasoning, reduce it to independent
transformations with only relevant excerpts; record the failed request and cost.
Do not feed the full lifecycle/history into a local configuration edit. Treat
transport/length failures separately from code defects, while charging both to
the batch spend. Changing model still requires a recorded routing decision.

A native Sol coordinator’s claim/review and a separate Sol verifier’s native ID
are lifecycle authority. DeepSeek request IDs, model/fingerprint, thinking,
usage and artifacts are implementation provenance, never Codex execution IDs.
Retain private responses and billable failed attempts. Public review evidence
links the published full SHA to contracts, request IDs, actual commands/results,
exclusions, repairs and the independent acceptance record.

## Observed Pro trial

[#17 / PR #56](https://github.com/mbelinkie/brainstorm/pull/56) split into a sample
quiz/test and RUNBOOK append. Pro high-thinking passed the fixture first try;
the RUNBOOK needed one localized wording repair. Independent Sol and integrated
main each passed 603 tests at the recorded SHAs. The fixture/test were exact
artifacts; the RUNBOOK preserved the repaired text with boundary newlines.
The balance fell from $18.47 to $18.41 at cent precision, with billing lag caveat.
No real room, generation, deployment, migrations, destructive cleanup or restart
harness was exercised. Flash results must be measured separately.

## Observed Flash setup slices

The routing update tried Flash on configuration/test transformations. The first
high-thinking packet included too much unrelated lifecycle context and exhausted
its 16,384-token output budget; its partial output was rejected without edits.
After reduction, a config-only low-thinking packet returned in 5.5 seconds;
a focused test packet returned in 32.6 seconds. Both artifacts passed the local
112-check lifecycle/planner gate without a code repair. Independent review and
integration evidence belong to the setup PR; these results do not establish
Flash’s reliability on larger product implementation. Include the failed call’s
usage/cost when comparing it with Pro. This reinforces relevant context and
small contracts, rather than simply increasing reasoning effort.
