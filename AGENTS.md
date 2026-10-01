# Codex operating pointer

This repository is a deployed, live-audience quiz platform. Read `CLAUDE.md`
first: it is the operating guide for agents working in this repo (the same
rules apply to Codex and Claude sessions).

For roadmap work (issues, claims, reviews, merges):

- Read `docs/PROJECT_OPERATING_PLAYBOOK.md`, `docs/roadmap/config.json`,
  `docs/roadmap/routing.md`, and `docs/roadmap/WORKING_A_TICKET.md` before
  touching the board.
- Routing uses native Codex Luna coding subagents: both `model:standard` and
  `model:economy` map to `gpt-6-luna`; logical `low`/`medium`/`high` effort maps
  to effective `medium`/`high`/`max`. Independent review uses `gpt-6.1-sol`.
- Use the lifecycle wrapper `scripts/roadmap/lifecycle.mjs` (never hand-write
  claim/review/block/completion comments) through the gate
  `scripts/roadmap/gate.mjs` (never call `gh` or the GitHub API directly).
- Your execution identity is this run's own `CODEX_THREAD_ID`. Never forge or
  inherit an id; conflicting environments fail closed.
- The orchestrator directly launches native coding and review subagents. The
  old subprocess dispatcher remains temporarily pending separate removal; it is
  not the supported route for new work.
