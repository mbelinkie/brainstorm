# Routing policy

Implements playbook §3. Every executable issue carries **exactly one**
`model:` label and **exactly one** `effort:` label before it can be Ready.

## Model profiles

Work is executed through the Codex **DeepSeek** profile. The model IDs below are
the provider model IDs passed to the runner (`codex exec -p deepseek --model <id>`).

| Label | Model | Provider model ID | Notes |
| --- | --- | --- | --- |
| `model:economy` | DeepSeek Flash | `deepseek-flash` | Mechanical, well-specified edits, docs, test scaffolding. |
| `model:standard` | DeepSeek V4 Pro | `deepseek-v4-pro` | Default for real feature and bug work. |

Choose the cheapest profile that safely fits. Authorization, data-loss, and
scoring work prefer `model:standard`.

## Effort levels

Effort labels are **logical** and remain `low`, `medium` and `high`:

| Label | Meaning |
| --- | --- |
| `effort:low` | Small, local change; little cross-file reasoning. |
| `effort:medium` | Normal bug fix or slice; some cross-module reasoning. |
| `effort:high` | Authorization, scoring, migrations, or hard cross-system state. |

The runner maps the logical label to its **effective** effort:

| Logical label | Runner effective effort |
| --- | --- |
| `low` | `low` |
| `medium` | `high` |
| `high` | `high` |

The claim records both the logical label and the runner's effective effort, so a
`medium` ticket is never misread as having run at a lower provider effort.
Unsupported effort/model mappings are resolved explicitly, never translated
silently. Split large issues instead of routing them upward.

## Evidence

Execution evidence records the exact provider model ID and effective effort
actually used, not just the label.

## Historical records

Older issues may still carry `model:standard`/`model:economy` meaning the retired
Claude profiles, and a few carry `escalation:opus`. Those are historical evidence
and remain readable; they never change a new run's routing. There is no active
Opus coding escalation in the current workflow.
