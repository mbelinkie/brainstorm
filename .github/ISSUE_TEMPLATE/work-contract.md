---
name: Work contract
about: A bounded, executable unit of work (playbook §2)
title: ""
labels: []
---

<!-- Replace every placeholder before the issue is moved to Ready.
     Public repo: no credentials, secrets, or sensitive local paths. -->

## Outcome
One observable result and why it matters.

## Scope
- Included work, affected modules, and required outputs.

## Exclusions
- Explicit boundaries, including adjacent work deferred elsewhere.

## Dependencies
<!-- One canonical entry per prerequisite, no prose. Use "None" only if true. -->
Blocked by #123

## Acceptance
Automated | External | Producer (choose one)
- [ ] Specific observable criterion.
- [ ] Focused regression checks and `npm test` pass.
- [ ] Retained evidence identifies the tested commit and reproduction steps.

## Verification
Exact commands or real-tool steps, expected results, and evidence locations.
For Producer acceptance: a short numbered checklist with what to inspect and the
exact acceptance response requested.

## Boundaries and authorization
Contract/fixture changes: None, or link the separately approved change note.
External inputs/services: None, or explicit privacy, retention, and cost policy.
Migrations: None, or note that the migration number is assigned by Matthew.

## Starting baseline
Required branch/commit, or `main`.

## Routing and size rationale
Why the selected `model:` profile, `effort:` level, and Size fit this task.
