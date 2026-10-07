# Codex operating pointer

## Started by the delegation harness with a role card?

Read **only** that card (`docs/delegation/cards/<role>.md`) and the input file the harness gave you. Do not read `CLAUDE.md`, the playbook, the guides or the worklog; the card contains every rule your step needs. Do the one step, end with the JSON object your card asks for, and stop.

## Any other session

This repository is a deployed, live-audience quiz platform. Read `CLAUDE.md` first: it is the operating guide for agents working in this repo, and the same rules apply to Codex and Claude sessions.

For roadmap work (issues, claims, reviews, merges):

- Read `docs/roadmap/WORKING_A_TICKET.md` and `docs/roadmap/routing.md`. The process itself is `docs/DELEGATION.md`.
- DeepSeek implements every product slice and fix through the delegation harness (`docs/delegation/HARNESS_SPEC.md`). Codex models decide, verify and coordinate: Luna for Express and Standard tickets, Sol for Protected tickets, escalations and audits.
- Use the lifecycle wrapper `scripts/roadmap/lifecycle.mjs` through the gate `scripts/roadmap/gate.mjs`. Never hand-write lifecycle comments, and never call `gh` or the GitHub API directly.
- Your execution identity is this run's own `CODEX_THREAD_ID`. Never forge or inherit an ID; conflicting environments fail closed.
- Batches start only at Matthew's request, through the harness. No Codex conversation acts as the batch dispatcher.
