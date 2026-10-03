# Routing policy

Every executable product issue keeps exactly one `model:` label and one `effort:` label. `config.json` mirrors the tables below; existing issue labels need no bulk edit. The full process is in [the delegation process](../DELEGATION.md). Sessions working a ticket read only their [role card](../delegation/cards/).

## Implementation profiles

DeepSeek implements every product slice and every fix through the [delegation harness](../delegation/HARNESS_SPEC.md). It is artifact-only: no tools, credentials or repository access. Codex models decide, verify and coordinate; they do not implement product code or fixes.

| Label | Model | Model ID | Use |
| --- | --- | --- | --- |
| `model:economy` | DeepSeek Flash | `deepseek-flash` | Mechanical, fully specified slices. The harness ladder starts here. |
| `model:standard` | DeepSeek Pro | `deepseek-v4-pro` | Normal feature and bug work. The ladder may start on Flash and climb to Pro (see below). |
| `model:controller` | Luna controller (not implementation) | `gpt-6-luna` | Execution-role allowlist only. Claim holder and gate for Express and Standard lanes; also the Verifier. Never a product-issue label. |
| `model:coordinator` | Sol coordinator (not implementation) | `gpt-6.1-sol` | Execution-role allowlist only. Claim holder for Protected-lane tickets; escalations and audits. Never a product-issue label. |

### Claims and verification

- **Express and Standard lanes:** the Luna Controller claims with model `gpt-6-luna`, logical effort `medium`, effective effort `high`, and the written reason "Luna controls; DeepSeek implements all slices".
- **Protected lane:** Sol claims with model `gpt-6.1-sol`, logical effort `medium`, effective effort `high`, and the written reason "Sol coordinates; DeepSeek implements all slices".
- **Effort must be real.** Each claim holder must actually run at the effective effort it records.
- **Verification** is by a separate Luna execution with its own native ID, at the final published SHA only.
- **Execution IDs.** Never claim with an invented ID, and never put a DeepSeek API request ID into `CODEX_THREAD_ID`.

### Pre-authorized implementation ladder

Matthew authorized this ladder on October 2, 2026. Each step is recorded automatically as a routing decision; none is a silent replacement.

| Attempt | Model | Thinking |
| --- | --- | --- |
| 1–2 | `deepseek-flash` | `high` |
| 3 | `deepseek-v4-pro` | `high` |
| 4 | `deepseek-v4-pro` | `max` |

- The ladder is capped at 4 attempts, followed by at most one Controller REPAIR, which restarts at attempt 3.
- The starting rung may be raised per category from ledger evidence.
- `model:standard` issues may start at attempt 3 when the ledger shows Flash rarely passes for that category.

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

Enable thinking explicitly. Each slice records the issue's logical label and DeepSeek's actual mode and effort, separately from the native claim. A claim holder's logical `medium` or `high` means its actual model runs at `high`.

## Execution and evidence

Use the official `https://api.deepseek.com` API with exact configured IDs. Check `/models` at batch start, and check the returned model on every response.

Record for each slice:

- the requested and returned model, fingerprint, request ID, thinking mode and effort;
- usage, balance observations, the accepted base SHA and the slice contract;
- the ladder steps, the checks run and any unverified boundaries.

Unknown usage is unknown, never zero. DeepSeek output is implementation evidence; acceptance comes only from harness checks plus the Controller and Verifier records.

Batch limits are in [the delegation process](../DELEGATION.md) §6: an 8-hour deadline, $10 of observed DeepSeek spend, and per-session Codex token budgets.

**Evidence so far:**

- [#17](https://github.com/mbelinkie/brainstorm/issues/17) through [PR #56](https://github.com/mbelinkie/brainstorm/pull/56) verified Pro for a fixture/test and a RUNBOOK append.
- Earlier Flash and Pro observations are in [LESSONS.md](LESSONS.md).
- Neither establishes reliability for recovery, credential handling or live generation.

## Historical records and restart

Older Luna, Claude and DeepSeek records remain readable. Preserve:

- live claims;
- published branches;
- pending acceptance;
- owner-assigned migration numbers.

**Tickets claimed under the October 1 policy finish under it.** A policy change never ends an existing claim. Reconcile stopped executions through lifecycle `release` before any replacement claim. Historical model and effort mappings describe their recorded runs, not the current defaults.

The planner stays read-only: `tools/codex-batch.mjs --dry-run` cannot claim, launch, publish, merge or complete. Batches start only on Matthew's instruction. See [Working a ticket](WORKING_A_TICKET.md) for the lifecycle mechanics.
