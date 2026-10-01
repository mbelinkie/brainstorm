# Routing policy

Implements playbook §3. Every executable issue carries **exactly one**
`model:` label and **exactly one** `effort:` label before it can be Ready.

## Model profiles

The Codex orchestrator launches native Luna coding subagents and an independent
Sol reviewer. Both coding labels currently select the same exact model; the
labels remain distinct for existing issue contracts and history.

| Label | Model | Model ID | Notes |
| --- | --- | --- | --- |
| `model:economy` | GPT-6 Luna | `gpt-6-luna` | Mechanical, well-specified edits and bounded coding work. |
| `model:standard` | GPT-6 Luna | `gpt-6-luna` | Default for real feature and bug work. |

The labels do not select different model capabilities today. Use
`model:standard` for the normal coding route; retain `model:economy` where
existing contracts or future triage use it. The independent reviewer uses
`gpt-6.1-sol` and verifies the change without taking over coding work.

## Effort levels

Effort labels are **logical** and remain `low`, `medium` and `high`:

| Label | Meaning |
| --- | --- |
| `effort:low` | Small, local change; little cross-file reasoning. |
| `effort:medium` | Normal bug fix or slice; some cross-module reasoning. |
| `effort:high` | Authorization, scoring, migrations, or hard cross-system state. |

The Codex runner maps the logical label to its **effective** effort:

| Logical label | Luna effective effort |
| --- | --- |
| `low` | `medium` |
| `medium` | `high` |
| `high` | `max` |

The claim records both the logical label and the effective effort used by the
Luna subagent. Unsupported effort/model mappings are resolved explicitly, never
translated silently. Split large issues instead of routing them upward.

## Evidence

Execution evidence records the exact model ID and effective effort actually
used, not just the label.

The orchestrator launches native Luna coding workers and an independent Sol
reviewer. `tools/codex-batch.mjs --dry-run` is a read-only planner for issues
#13–44; it cannot claim tickets, start subprocesses, access provider balances,
publish, merge or complete work. Claims and lifecycle state remain with the
shared lifecycle and gate. The native Luna/Sol rehearsal has not yet been
recorded as complete.

## Historical records

Older issues and claim records may name Claude or DeepSeek model IDs, and some
carry `escalation:opus`. They remain readable as historical evidence. New claims
must use a currently configured model; `--allow-mismatch` cannot authorize a
retired or otherwise unsupported coding model. There is no active Opus coding
escalation in the current workflow.
