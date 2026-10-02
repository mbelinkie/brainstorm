# Delegation harness

The script that runs delegated batches: [process](../../docs/DELEGATION.md), [spec and implementation status](../../docs/delegation/HARNESS_SPEC.md), [role cards](../../docs/delegation/cards/). Node 24, no dependencies.

## One-time setup (Matthew's Mac)

1. **Private state folder.** The default is `~/.local/share/brainstorm-delegate`. Set `DELEGATE_HOME` to use another folder outside the repository.
2. **DeepSeek key.** Put the key in `$DELEGATE_HOME/deepseek.key`, or point `DEEPSEEK_KEY_FILE` at the existing private key file, then `chmod 600` it. The harness refuses a key file other users can read, and never prints the key or puts it in a prompt.
3. **Codex.** `codex` must be on `PATH`, logged in to the one ChatGPT account. Check that `codex exec --help` lists `--json`, `-o` and `--output-schema`.
4. **GitHub.** `gh auth status` must show the `repo` and `project` scopes. The harness reaches GitHub only through the roadmap gate.

## Smoke test before the first real batch

The harness was built and tested with fake DeepSeek and fake Codex. Before trusting it, check the parts that could not be checked that way, on one low-risk Express ticket that Matthew has marked Ready:

1. `node tools/delegate/run.mjs start --deadline-hours 2 --usd 2`. Expect "models ok" and the balance baseline.
2. `node tools/delegate/run.mjs ticket <n>`, then confirm:
   - **Codex output was parsed:** `$DELEGATE_HOME/tickets/<n>/codex/*/events.jsonl` contains a `thread.started` event and `turn.completed` events with `usage`. If the field names differ, `core/codex.mjs` `parseEvents` needs updating.
   - **Plan usage was read:** `node tools/delegate/run.mjs status` shows a plan reading, not "unknown". If it stays unknown, find the `rate_limits` fields in `~/.codex/sessions/**/rollout-*.jsonl` and update `parseRateLimits`. Until then the batch stops after one session. That is intended: unknown usage counts as exhausted. Setting `plan.requireUsageReading` to `false` turns this off deliberately.
   - **The claim went through from inside the Codex sandbox** (it needs network access and the gh login). If it didn't, adjust `codex.extraConfig` in `config.json`.
   - **The live claim's execution ID equals the session's thread ID.** The harness checks this and blocks on a mismatch.
3. Read `$DELEGATE_HOME/tickets/<n>/bundle.md` and the PR. Have Sol review the harness once, as the spec requires, before widening to Standard tickets.

## Running a batch

```bash
node tools/delegate/run.mjs start            # only on Matthew's instruction
node tools/delegate/run.mjs run              # loops until done, deadline, budget, plan limit or STOP
node tools/delegate/run.mjs status
node tools/delegate/run.mjs stop             # stop after the current step
```

`run` picks up unfinished tickets first, so re-running it after a crash resumes from the last checkpoint. Blocked and flagged tickets carry a lifecycle `block:v1` comment that says what is needed and from whom.

## Measuring and tuning

```bash
node tools/delegate/run.mjs reopens          # record which finished tickets were reopened (last 14 days)
node tools/delegate/run.mjs report           # credits per kept ticket, per-category stats, recommendations
```

`report` only recommends; you apply changes in `config.json`:

- **`categoryOverrides`**, keyed by the Project's Workstream: `minLane` raises a category's lane (`"protected"` sends it straight to Sol), and `ladderStart: 2` starts it on the Pro rung.
- **`budgets`:** per-session token limits.
- **`deepseek.scout.model`.**
- **`audit`:** the Sol audit sample. By default every one of the first 10 Luna-accepted tickets is audited, then 1 in 5 up to 30, then 1 in 20. Audit results are in `$DELEGATE_HOME/audits.json`, and a defect is printed in the batch log.
- **`batch.triageBatchSize`:** above 1, several Ready tickets are triaged in one Luna session.

## Changing the harness

The harness is Protected-lane code. After any change, run `npm test` and `npm run test:harness` (the end-to-end runs; about 50 seconds), and have Sol review it.

## What lives where

| Path | Contents |
| --- | --- |
| `config.json` | Lanes, protected paths, the ladder, budgets, plan headroom, models (no secrets) |
| `core/*.mjs` | Pure logic: guards, artifacts, JUnit, ladder, bundle, recon, Codex parsing |
| `deepseek.mjs` | DeepSeek client: no tools, every response recorded |
| `codex-session.mjs` | Launches `codex exec` with identity variables stripped |
| `pipeline.mjs` | The ticket phases, intake to finish |
| `run.mjs` | Command line |
| `prompts/` | Stable DeepSeek prefixes (version line at the top; bump it on any edit) |
| `$DELEGATE_HOME` | Batch state, per-ticket state, DeepSeek records, Codex session logs, `ledger.csv` |
