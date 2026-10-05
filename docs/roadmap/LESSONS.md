# Delegation lessons

Observed evidence from earlier runs. Read this file on recovery, or when
changing the process. Sessions working a ticket don't need it.

## Verified rehearsal lessons (2026-10-01)

The native route completed [#51](https://github.com/mbelinkie/brainstorm/issues/51)
through [PR #52](https://github.com/mbelinkie/brainstorm/pull/52). Sol verified
`5941527a57299c746ff65af9806b4aac321a9d01`; merge commit
`bc1d37421bc37769f05aec2ee59788b8761fe397` preserved it. All 554 tests passed
in Sol's clean checkout and on integrated main. Repeating `complete` returned
`alreadyCompleted`; `stale` confirmed Closed/Done, no live claim or discrepancy.

- **Native identity:** a child can have its own `CODEX_THREAD_ID` while inheriting
  the parent's different `CODEX_SESSION_ID`. For lifecycle calls in that child,
  use `env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs ...`, retaining
  its actual thread ID. An ambiguous identity must stop consequential actions.
  Sol found a self-release bypass missed by the suite; Luna reproduced it with
  a failing regression and fixed it before renewed verification.
- **Live decisions:** Ready status does not resolve an explicitly pending choice.
  Conversely, an affirmative owner decision can be complete but use wording the
  strict planner rejects. Preserve the original evidence while normalizing the
  boundary field, for example `Migrations: Assigned by Matthew: 0037` or
  `Owner decisions: None.` with a separate `Resolved owner decision:` line.
  Here `None` means no outstanding choice. Normalization never assigns a number
  or decides a value. Re-read newly promoted tickets; the planner scans #13–44.
- **Recovery notes:** privately retain the deadline, dispatcher-lock owner,
  issue/agent identity, branch, published SHA, verifier SHA and lifecycle phase.
  Compare them with fresh GitHub/git evidence before the next write. Resume the
  claim holder to record its own review; the dispatcher cannot impersonate it.
- **Waiting:** native agents use `collaboration.wait_agent`. `functions.wait`
  accepts only a running exec cell ID, never an agent name or an invented ID.
- **Handoffs:** confirm native spawn/resume/wait controls remain available after
  a model or tool handoff. A completed child turn can still have an app-owned
  thread writer: a CLI resume of #42 was refused with `already has an active
  writer`. Preserve the claim and published work; resume through the owning
  native controls rather than replacing its identity or removing writer locks.
- **Evidence limits:** the Cloudflare Workers Builds check failed on both the
  starting baseline and integrated main. Passing repository tests established
  setup correctness; deployment success remained unproven and outside scope.

## Observed Pro trial (#17)

[#17 / PR #56](https://github.com/mbelinkie/brainstorm/pull/56) split into a sample
quiz/test and RUNBOOK append. Pro high-thinking passed the fixture first try;
the RUNBOOK needed one localized wording repair. Independent Sol and integrated
main each passed 603 tests at the recorded SHAs. The fixture/test were exact
artifacts; the RUNBOOK preserved the repaired text with boundary newlines.
The balance fell from $18.47 to $18.41 at cent precision, with billing lag caveat.
No real room, generation, deployment, migrations, destructive cleanup or restart
harness was exercised. Flash results must be measured separately.

## Observed Flash setup slices (routing update)

The routing update tried Flash on configuration/test transformations. The first
high-thinking packet included too much unrelated lifecycle context and exhausted
its 16,384-token output budget; its partial output was rejected without edits.
After reduction, a config-only low-thinking packet returned in 5.5 seconds;
a focused test packet returned in 32.6 seconds. Both artifacts passed the local
112-check lifecycle/planner gate without a code repair. Independent review and
integration evidence belong to the setup PR; these results do not establish
Flash’s reliability on larger product implementation. Include the failed call’s
usage/cost when comparing it with Pro. This reinforces relevant context and
small contracts, rather than simply increasing reasoning effort.
