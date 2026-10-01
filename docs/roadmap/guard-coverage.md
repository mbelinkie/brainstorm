# Command guard: what it covers and what it does not

Issue #6, playbook section 7. The guard is a **pre-command check for Claude Code's
shell tools**. It is **not a sandbox** and **not a backup**: it reads the text of
a command and refuses a short list of destructive or shared-state commands. It
does nothing for work that was already lost, and it is only active once the owner
installs it (see [Installing](#installing)).

Files: `scripts/guard/command-guard.mjs` (decision logic, pure),
`scripts/guard/pre-command-hook.mjs` (the Claude Code adapter),
`scripts/guard/worktree-checks.mjs` and `tools/worktree-setup.mjs` (worktree bootstrap).

## What it refuses

Each refusal names its rule. The guard reads quotes, `&&` / `||` / `;` / `|`
chains, newlines, `$(...)` and backticks, `bash -c`, `powershell -Command`
(including `-EncodedCommand`), `cmd /c`, `eval`, `sudo`/`env`/`xargs` prefixes,
`npx`/`pnpm dlx`-style launchers, `find -exec`, program paths such as
`/usr/bin/git` and `git.exe`, and git's global options such as `-C` and `-c`. A
refused command word that only appears inside a quoted argument (a commit
message, an `echo`) is not a command and is allowed.

| Rule | Refuses | Why |
| --- | --- | --- |
| `reset-hard` | `git reset --hard` | discards uncommitted work |
| `git-clean` | any `git clean` | deletes untracked files |
| `force-push` | `--force`, `-f`, `--force-with-lease`, `--mirror`, `--delete`, `+ref` and `:ref` pushes | rewrites or removes shared history |
| `add-all` | `git add -A`, `--all`, `-u`, `.`, `*`; `git commit -a` / `--all` | stage explicit paths only |
| `stash` | `git stash` except `list` and `show` | no automatic stashing |
| `branch-force-delete` | `git branch -D`, `-d` with `-f` | use `-d`, which refuses unmerged work |
| `discard-changes` | `git checkout .`, `checkout -f`, `restore .` (not `--staged`-only), `switch -f` / `--discard-changes` | wholesale loss of working-tree changes |
| `worktree-force-remove` | `git worktree remove --force` | can lose untracked files |
| `deploy` | `wrangler deploy` / `publish` / `rollback`, `npm|pnpm|yarn|bun run deploy` | deploys stay with the owner |
| `supabase-write` | `supabase db push`, `db reset`, `migration repair`, `functions deploy` | mutates the production project |
| `recursive-delete` | `rm -r`, `Remove-Item -Recurse`, `rmdir /s`, `del /s`, `find -delete`, unless every target is strictly inside a scratch directory | no recursive deletion outside a scratch directory |
| `unparseable` | a command with an unbalanced quote or substitution | it cannot be checked, so it is refused |

Scratch directories are the OS temp directory plus any in the
`GUARD_SCRATCH_DIRS` environment variable. A relative delete target is judged
against the call's working directory; globs, `$VAR`, `~` and `..` escapes are refused.

## What it does NOT cover

Be honest about these before relying on it:

- **Indirect execution.** A script, Makefile or `npm run <name>` that internally runs `git reset --hard` is not seen; only the command line is read. `node -e` / `python -c` bodies are not parsed.
- **Aliases and shell functions.** Anything defined in a profile or earlier in the session.
- **Variable indirection.** `$G reset --hard`, `git $(echo reset) --hard` built at run time, and obfuscation beyond what the text shows.
- **Another tool.** The guard hooks the Bash and PowerShell tools only. Edit, Write, MCP tools and a browser can still change or delete things.
- **A human shell, or another agent runner.** A terminal you type in, an IDE button, a GUI such as GitHub Desktop, and any runner that does not load this hook are not protected.
- **Allowed but sensitive commands.** Plain `git push`, `merge`, `rebase`, `commit --amend`, `git tag -d` and `rm` of a single file are allowed; CLAUDE.md's rules about asking first still apply to them.
- **Hook not loaded.** If `.claude/settings.json` does not load the hook, or the session was not started from the repository root, nothing is guarded. A hook that crashes before it can answer does not block the command (Claude Code treats most hook errors as non-blocking); the adapter catches its own errors and refuses instead, but a broken `node` or a missing script path cannot be caught by the script itself.
- **Backups.** This is not a backup. Git history, worktrees and immutable snapshots are not independent backups (issue #7 covers backups).

## Installing

Not installed by this change. The owner reviews `docs/roadmap/claude-settings.guard.json`
and merges its `hooks` block into `.claude/settings.json` (project) or the user settings.
Restart the Claude Code session afterwards; hooks load at session start. To check it
worked, ask the session to run a refused command such as `git reset --hard` in a scratch
repository: it should be denied with the rule named.

## Worktrees

`node tools/worktree-setup.mjs [--base <commit>] [--dry-run]`, run inside a new
worktree, checks: not on `main`, clean tree, the base commit is an ancestor of HEAD,
`node_modules` is not a link into another worktree, `package-lock.json` exists, and
the Node version matches a pinned `.nvmrc` if there is one. Only if all pass does it run
`npm ci`. It uses read-only git commands and never resets, cleans, checks out or
stashes. It does not prove the install matches the lockfile beyond what `npm ci` itself enforces.
