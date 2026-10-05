# Instructions for whoever writes tickets: is this one for the harness?

Give this to the model that creates tickets. It decides, at creation time, whether a ticket can go to the delegation harness, and records why. Project-specific details go in the last section; everything above it is the same for every project.

---

## Your job

Every ticket you create gets exactly one of these labels:

- **`delegate:yes`**: the harness may take it. Cheap models implement it, and done is proved by automated tests. No person looks at it until the pull request.
- **`delegate:no`**: a person, or an interactive session with a person, does it.

You also add a **Harness fit** section to the ticket body (template below) that shows your reasoning. When in doubt, choose `delegate:no` and say what would make it `yes`. A wrong `yes` costs a failed batch and an expensive escalation; a wrong `no` costs one interactive session.

## `delegate:yes` only if every one of these is true

1. **A test can prove it's done.** Every acceptance item is checkable by the project's normal test command, with fixtures or fakes. If any item needs a person to look, a live service, a real device, a real account or real money, the answer is `no`, or split the ticket (see "Split instead of refusing").
2. **Every decision is already made.** Names, formats, field mappings, error behavior, environment variable names, limits and edge cases are written in the ticket or pointed to in existing code by file path. If you would write "decide", "TBD", "choose an approach" or "as appropriate", the answer is `no` until the decision is made.
3. **Every source you cite exists and is current.** You opened each file and spec section you reference, and it says what the ticket claims. Name the exact file and heading. A spec section that a later document overrides is a broken contract, not a source.
4. **It is small and bounded.** One behavior, or a few closely related ones. You can name the files it will change, and there are about a dozen or fewer. The diff should fit in a few hundred lines.
5. **There is a pattern to follow.** Best: "same shape as `<function>` in `<file>`". A ticket that invents a new structure is usually `no`.
6. **It stays out of protected areas** (unless the project section below says otherwise):
   - database migrations, row-level security, grants or access policy;
   - credentials, secrets or environment handoff;
   - anything destructive (deleting data, irreversible operations);
   - billing, usage metering or cost accounting;
   - the project's own process tooling (lifecycle, gates, guards, CI, deploy scripts, the harness);
   - restart, recovery or concurrency.

   These can still be delegated, but only through the expensive design model, and only when the owner explicitly wants that. Default to `no`, and say why in the Harness fit section.
7. **Nothing outside the repository is needed.** No live API calls, no accounts, no purchases, no manual setup. Tests never call real services.
8. **Its dependencies will be done before it starts.** List them. If one is still open, the ticket can be `yes`, but it will not be dispatched until they close.

## Always `delegate:no`

- Design, UX, visual or copy judgment.
- Research, investigation, "figure out why" and debugging something not yet reproduced by a failing test.
- Anything whose acceptance includes a person trying it (a real room, a real phone, a real user).
- Broad refactors, renames across the codebase and dependency upgrades.
- Deploys, migrations being applied and production changes.

## Split instead of refusing

Many tickets mix a testable core with work that needs a person. Split them:

- **Core ticket (`delegate:yes`):** the pure logic, with fixtures. For example, an adapter's request builder and response parser, tested against recorded responses.
- **Wiring ticket (`delegate:no`):** connecting it to the live service, trying it for real, and the decisions that need the owner.

Make the wiring ticket depend on the core ticket.

## Harness fit section (add to every ticket)

```markdown
## Harness fit
Label: delegate:yes | delegate:no
Why: <one or two sentences>
Predicted lane: express | standard | protected
Files it should touch: <paths>
Pattern to follow: <function/file, or "none">
Open decisions: None | <list>   (any item here means delegate:no)
Would become yes if: <only for delegate:no; or "never: needs a person">
```

The harness's own triage still checks every `yes` ticket, so this label is necessary but not sufficient. The predicted lane is compared with the lane the harness decides; a mismatch means the ticket hid something, and that is worth learning from.

## Before you finish

Re-read the ticket as a stranger who cannot ask questions. For each acceptance item, say to yourself which test would prove it. For each noun the code will use (a field, a variable, a file), say where its exact spelling comes from. If either answer is "the implementer will work it out", change the label to `no` or make the decision now.

---

## Project section (fill in per project)

- **Test command:** for example `npm test` (Brainstorm), `pytest`, `npx vitest run`.
- **Ticket template sections the harness reads:** for Brainstorm, Outcome, Scope, Exclusions, Dependencies, Acceptance, Verification, and "Boundaries and authorization" (with "Owner decisions: None" and "Migrations: None" for anything delegable).
- **Extra protected areas:** for Brainstorm, anything that changes how quiz data is stored or loaded (old quizzes must still load).
- **Exceptions the owner has approved:** none yet.
