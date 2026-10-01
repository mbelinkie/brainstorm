# Codex operating pointer

This repository is a deployed, live-audience quiz platform. Read `CLAUDE.md`
first: it is the operating guide for agents working in this repo (the same
rules apply to Codex and Claude sessions).

For roadmap work (issues, claims, reviews, merges):

- Read `docs/PROJECT_OPERATING_PLAYBOOK.md`, `docs/roadmap/config.json`,
  `docs/roadmap/routing.md`, and `docs/roadmap/WORKING_A_TICKET.md` before
  touching the board.
- DeepSeek implements bounded slices: `model:economy` uses `deepseek-flash`;
  `model:standard` uses `deepseek-v4-pro`. Read
  `docs/DEEPSEEK_CODING_GUIDE.md` before planning, dispatching or repairing a
  slice. A native Sol coordinator holds the claim; a separate `gpt-6.1-sol`
  execution independently verifies the published commit. See routing.md for
  honest coordinator identity and effort recording; no Luna coding fallback.
- Use the lifecycle wrapper `scripts/roadmap/lifecycle.mjs` (never hand-write
  claim/review/block/completion comments) through the gate
  `scripts/roadmap/gate.mjs` (never call `gh` or the GitHub API directly).
- Your execution identity is this run's own `CODEX_THREAD_ID`. Never forge or
  inherit an id; conflicting environments fail closed.
- The orchestrator assigns DeepSeek slices and launches native Sol coordination
  and review subagents. Start batches only at Matthew’s request.
  `tools/codex-batch.mjs --dry-run` is a read-only planner for issues #13–44; it
  cannot claim, launch, publish, merge or complete work.
