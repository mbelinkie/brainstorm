# Routing policy

Executable product issues keep exactly one `model:` and one `effort:` label.
The config mirrors the tables below; existing issue labels need no bulk edit.

## Implementation profiles

DeepSeek implements bounded behavior slices using
[the coding guide](../DEEPSEEK_CODING_GUIDE.md). Sol defines contracts and
acceptance, runs checks, publishes and coordinates; a separate `gpt-6.1-sol`
execution independently reviews the exact published SHA. Sol does not take over
product implementation or review fixes. No Luna or OpenAI coding fallback.

| Label | Model | Model ID | Use |
| --- | --- | --- | --- |
| `model:economy` | DeepSeek Flash | `deepseek-flash` | Mechanical, fully specified slices; evaluate quality under the same acceptance gate. |
| `model:standard` | DeepSeek Pro | `deepseek-v4-pro` | Normal feature and bug work, split into explicit slices. |
| `model:coordinator` | Sol coordinator (not implementation) | `gpt-6.1-sol` | Execution-role allowlist only; never assign this label to product issues. |

The coordinator profile lets the existing wrapper validate the real native Sol
claim holder without disguising it as DeepSeek. Claim with actual model
`gpt-6.1-sol`, logical effort `medium`, effective `high`, and a written
`--allow-mismatch` reason: “Sol coordinates; DeepSeek implements all slices.”
This coordination mismatch is authorized by Matthew’s instruction to adopt the
sliced workflow; it is not permission for Sol implementation or model fallback.
The coordinator must actually run at high effort. Never claim with an invented
DeepSeek UUID or put a DeepSeek API request ID into `CODEX_THREAD_ID`.

## Effort levels

| Label | Meaning |
| --- | --- |
| `effort:low` | Simple local behavior with an explicit contract. |
| `effort:medium` | Normal bounded bug fix or feature. |
| `effort:high` | Complex contract or critical invariants; split before dispatch. |

| Logical label | DeepSeek effective effort |
| --- | --- |
| `low` | `low` |
| `medium` | `high` |
| `high` | `high` |

Enable thinking explicitly. Each slice records the issue’s logical label and
DeepSeek’s actual mode/effort separately from the native coordinator claim.
Coordinator logical `medium` or `high` means actual Sol `high`; its claim does
not report DeepSeek effort. A different coordinator effort requires an explicit
supported mapping; do not silently translate or misstate it.

## Execution and evidence

Use the official `https://api.deepseek.com` API and exact configured IDs. Confirm
both IDs are available on `/models`, then verify the returned model on each
response. The default harness is artifact-only Chat Completions with no tools:
the orchestrator supplies relevant public source, accepts only allowlisted
artifacts, and runs checks locally. The saved key stays in the private parent
request wrapper; DeepSeek receives neither secrets nor credential/file/Git tools.
Preserve Sol’s normal Codex configuration. A tool-enabled CLI harness requires
separate evidence for identity, permissions, reasoning replay and side effects
before use; the fixture trial did not verify it.

Record requested/returned model, fingerprint if exposed, request ID, thinking
mode, effort, usage, balance observations, accepted base SHA, slice contract,
repair count, checks and unverified boundaries. Unknown usage is unknown, never
zero. DeepSeek reports are implementation evidence; Sol acceptance is separate.

Both models follow the same guide and one-localized-repair rule. Failed Flash
work is preserved and reduced or blocked after that budget; switching to Pro
requires an explicit recorded routing decision, not a silent retry. Measure
accepted correctness, repairs, Sol time and total cost for comparable slices.

[#17](https://github.com/mbelinkie/brainstorm/issues/17) through
[PR #56](https://github.com/mbelinkie/brainstorm/pull/56) verified Pro for a sample
fixture/test and RUNBOOK append: first-pass fixture, one documentation repair,
603 passing tests in independent Sol and integrated main. It establishes no
reliability for recovery, credential handling or live generation. Flash uses
the same gates; retain its actual results rather than inferring parity.

## Historical records and restart

Older Luna, Claude and DeepSeek records remain readable. Preserve live claims,
published branches, pending acceptance and owner-assigned migration numbers.
Reconcile stopped executions through lifecycle release before any replacement
claim; changing this policy never ends an existing claim. Historical model/effort
mappings describe their recorded runs, not the current defaults.

The planner remains read-only: `tools/codex-batch.mjs --dry-run` cannot claim,
launch, publish, merge or complete. Batches start only on Matthew’s instruction;
see [Working a ticket](WORKING_A_TICKET.md) for limits, publication and recovery.
