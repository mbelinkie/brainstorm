# Delegation harness

The script that runs delegated batches: [process](../../docs/DELEGATION.md), [spec and implementation status](../../docs/delegation/HARNESS_SPEC.md), [role cards](../../docs/delegation/cards/). Node 24, no dependencies.

## One-time setup (Matthew's Mac)

1. **Private state folder.** The default is `~/.local/share/brainstorm-delegate`. Set `DELEGATE_HOME` to use another folder outside the repository.
2. **DeepSeek key.** Put the key in `$DELEGATE_HOME/deepseek.key`, or point `DEEPSEEK_KEY_FILE` at the existing private key file, then `chmod 600` it. The harness refuses a key file other users can read, and never prints the key or puts it in a prompt.
3. **Codex.** `codex` must be on `PATH`, logged in to the one ChatGPT account. Check that `codex exec --help` lists `--json`, `-o` and `--output-schema`.
4. **GitHub.** `gh auth status` must show the `repo` and `project` scopes. The harness reaches GitHub only through the roadmap gate. Codex sessions also need a GitHub token file (`$DELEGATE_HOME/github.token` or `DELEGATE_GITHUB_TOKEN_FILE`, `chmod 600`), because `gh` in the sandbox cannot use the keychain login.

## Smoke test before the first real batch

The harness was built and tested with fake DeepSeek and fake Codex. The first real run checks what fakes can't:

- Codex's real output format;
- plan-usage reading;
- the lifecycle claim from inside Codex's sandbox;
- DeepSeek on real prompts.

**Prerequisite:** PR #62 is merged to `main`. Ticket worktrees start from `main` and need its lifecycle config and `AGENTS.md`.

1. **Use a dedicated clone of the harness branch** (for example `~/delegate/brainstorm` on `claude/delegate-harness`), not your everyday checkout:
   - ticket worktrees are created next to it;
   - the Verifier's sandbox must be able to write to its git directory.

   Then run `npm ci`, `npm test` and `npm run test:harness`.
2. **Use a dedicated Codex home on the one account:**

   ```bash
   export CODEX_HOME=~/.codex-delegate
   codex login
   ```

   The harness reads plan usage from this home's session logs. It calls `codex` from PATH: run `codex update` first. An old CLI is not offered the gpt-6 models and Codex refuses them ("not supported when using Codex with a ChatGPT account").
3. **Give Codex sessions a GitHub token.** Inside Codex's sandbox, `gh` cannot read the keychain login and calls GitHub anonymously, so the claim fails with `QUOTA_EXHAUSTED`. Save a fine-grained token limited to the repositories the harness works on (30-day expiry) as `$DELEGATE_HOME/github.token`, or point `DELEGATE_GITHUB_TOKEN_FILE` at it, and `chmod 600` it. The harness refuses to start without it, and passes it only to Codex sessions, as `GH_TOKEN`. Do not export it in your shell.
4. **Point the harness at the key.** Set `export DEEPSEEK_KEY_FILE=<your existing private key file>`, and make sure the file is `chmod 600`.
5. **Pick one small, low-risk Automated ticket** and make it the planner's top Ready ticket:

   ```bash
   node tools/codex-batch.mjs --dry-run
   ```

   should select it.
6. **Start a short batch** with `node tools/delegate/run.mjs start --deadline-hours 2 --usd 2`. Expect "models ok" and the balance baseline.
7. **Run the ticket** with `node tools/delegate/run.mjs ticket <n> --no-merge`. It stops after independent verification and leaves the PR for you to merge.
8. **Check the run** (in `$DELEGATE_HOME`, default `~/.local/share/brainstorm-delegate`):
   - **Codex output was parsed:** `tickets/<n>/codex/*/events.jsonl` has a `thread.started` event and `turn.completed` events with `usage`. If not, update `parseEvents` in `core/codex.mjs`.
   - **Plan usage was read:** `run.mjs status` shows a plan reading, not "unknown". If not, find the `rate_limits` fields in `$CODEX_HOME/sessions/**/rollout-*.jsonl` and update `parseRateLimits`. Until then the batch stops after one session, deliberately.
   - **The claim went through from inside the sandbox.** If it didn't, adjust `codex.extraConfig` in `config.json`.
   - **The claim on the issue names the Luna session's thread ID.** The harness also checks this.
   - **DeepSeek behaved:** `tickets/<n>/bundle-S1.md` reads sensibly, and the PR diff does what the ticket asks.
9. **Finish by hand:** follow `tickets/<n>/signoff.md`. Merge with a merge commit, run `npm test` on `main`, then run lifecycle `complete`.

After a clean pilot, have Sol review the harness once before running without `--no-merge`.

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
