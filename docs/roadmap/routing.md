# Routing policy

Implements playbook §3. Every executable issue carries **exactly one**
`model:` label and **exactly one** `effort:` label before it can be Ready.

## Model profiles

| Label | Model | Notes |
| --- | --- | --- |
| `model:economy` | Haiku 4.5 (`claude-haiku-4-5-20251001`) | Mechanical, well-specified edits, docs, test scaffolding. |
| `model:standard` | Sonnet 5.5 (`claude-sonnet-5-5`) | **The ceiling profile.** Default for real feature and bug work. |

There is deliberately **no** `model:advanced` profile. API budget is limited
(decision by Matthew, 2026-09-30), so Sonnet is the top model in the system.

### Opus escalation (exception, not a profile)

Opus may be used for bounded problem solving on **one issue** only after Sonnet
has failed. To escalate, add the `escalation:opus` label and record in the
issue, in this order:

1. the checks Sonnet attempted and their results,
2. the failure or remaining risk,
3. the smallest next scope Opus will be asked to solve,
4. Matthew's go-ahead.

The label stays on the issue as history. Escalation never changes the issue's
`model:` label, and never applies to later issues by default.

## Effort levels

| Label | Meaning |
| --- | --- |
| `effort:low` | Small, local change; little cross-file reasoning. |
| `effort:medium` | Normal bug fix or slice; some cross-module reasoning. |
| `effort:high` | Authorization, scoring, migrations, or hard cross-system state. |

Runner mapping: the runner (Claude Code) takes the effort level as a session
setting. Unsupported model/effort combinations must be resolved explicitly,
never translated silently.

Choose the cheapest profile and effort that safely fits. Authorization,
data-loss, and scoring work get `effort:high` rather than a bigger model.
Split large issues instead of routing them upward.

## Evidence

Execution evidence records the exact model ID actually used, not just the label.
