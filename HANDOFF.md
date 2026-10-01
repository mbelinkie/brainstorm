# Handoff — where Quiz Control / Brainstorm stands

Written 2026-09-23 when the project moved from Matthew's Mac to his work PC.
The last active development was 2026-08-26. This file is a snapshot: prefer git
history, `docs/CLAUDE_WORKLOG.md` and Matthew's latest instruction over it, and
update or delete it once it stops being true.

## Branches

| Branch | State |
|---|---|
| `main` | Ends at the 2026-08-18 integration: the player and host recovery batch, and the 0034/0035 scoring migrations. It had 17 commits that existed only on the Mac until they were pushed on 2026-09-23. |
| `claude/prompt-battle-engine` | **The active branch.** 12 commits ahead of `main`: Prompt Battle slices 1 and 2, the Workers AI model profiles, the `/media` edge-cache fix (`a6513bf`) and the consolidated spec. **Not merged to `main`.** Merging is Matthew's call. |
| `claude/prompt-battle-free-engine` | Fully contained in `prompt-battle-engine` (a docs commit). Safe to delete once confirmed. |
| `claude/prompt-battle-slice-1` | Old WIP branch, superseded by `prompt-battle-engine`. |

## In flight: Prompt Battle (AI image round type)

The source of truth is
`docs/superpowers/specs/2026-08-26-prompt-battle-architecture.md`. Read it fully
before touching this feature; the two older specs are useful for rationale but
wrong on specifics.

- **Slice 1** (adapter layer, Worker test route, host test panel): done.
- **Slice 2** (schema, pairing, engine selection): done. Committed as `3aab152`
  on 2026-09-23. Migration `0036_prompt_battle_rounds.sql` **is applied to
  production** and was verified read-only on 2026-08-25.
  - The 2026-08-26 session was asked to review the slice 2 diff before
    committing it. It hit the spend limit mid-review, so **slice 2 has not had
    an independent review.** It is worth doing before slice 3 builds on it.
  - Still unproven, per the worklog: no battle RPC has been called against a
    real room; `open_battle_round`'s idempotency is only proven in the source;
    the host cannot yet navigate into a `prompt_battle` round; and
    `set_battle_engine` has no UI.
- **Slice 3 (player generation loop): next, not started.** Slices 4 to 6 follow
  (submit and host veto; voting, scoring and presentation; retention, purge and
  export).
- **Kaplan Cloud Run proxy:** approved by Kaplan IT on 2026-08-26 and
  unblocked, but not started. This is a parallel track to the slices, covered in
  spec §5. The IAM roles were granted to `matthew.belinkie@kaplan.com`, so the
  **work PC is the natural place to build it**. Use spec §5.5 option 2: build
  the container locally (needs Docker and `gcloud`), push it to Artifact
  Registry, then run `gcloud run deploy --image`. Ask David for a Cloud Build
  role only if that fails.

## Check before the next deploy

Deploys copy the working directory (see "Operational lessons" in `CLAUDE.md`).
The Mac's checkout sat on `claude/prompt-battle-engine` for most of late August,
so **what is live is unknown**: it could be `main`, the battle branch, or
something older.

1. **Find out what is live.** Grep live assets for markers from each branch
   before deciding what to deploy.
2. **Check the Supabase Cached Egress fix (`a6513bf`) is actually live.** The
   org was over quota with a grace period ending 2026-09-17, which has passed.
   Check the org usage page's Cached Egress chart, and whether any restriction
   was applied.

## Not in git (copied over by hand)

- `.dev.vars`: Worker secrets for `wrangler dev`.
- `.env.local`: the deploy script sources it. **Never read, print or copy it
  in a session** (see `CLAUDE.md`).
- `music quiz originals/`: raw source media. Gitignored by design.
- `local-reference/`: reference material, including the Gemini API notes.

Generated, so rebuild rather than copy: `node_modules/`,
`video-processor.worker.bundle.js` (`npm run build:video`), `.deploy-assets/`,
`.wrangler/`.
