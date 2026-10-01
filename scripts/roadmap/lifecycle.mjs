// Roadmap lifecycle wrapper, part 1 of 2 (issue #3): inspect, ready, claim, block.
// Review, complete and stale-claim recovery are issue #45.
//
//   node scripts/roadmap/lifecycle.mjs <op> <issue> [--json] [flags]
//
// Every GitHub read and write goes through the shared gate (gate.mjs), and every
// operation runs inside gate.session() so one lock covers the live re-read and
// the writes that follow it. Expected refusals are returned as
// { ok: false, code, message }, never thrown, and a refusal is always decided
// before the first write.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createGate } from "./gate.mjs";
import { createGhTransport } from "./github-transport.mjs";
import { createFinish } from "./lifecycle-finish.mjs";
import {
  effectiveEffort,
  evaluateRouting,
  findIndependentVerification,
  isRepoName,
  hasCompletionRecord,
  latestBlockCause,
  markedComments,
  parseAcceptanceClass,
  parseClaims,
  parseContract,
  parseDependencies,
  parseReviewComment,
  renderBlockComment,
  renderClaimComment,
  resolveExecutionId,
  splitRef,
} from "./lifecycle-core.mjs";

const PROMOTABLE = ["Backlog", "Blocked", "Ready"];
const MAX_PREREQUISITES = 20;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 5000;

const ITEM_SELECTION = `id
  project { id number owner { ... on User { login } ... on Organization { login } } }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  acceptance: fieldValueByName(name: "Acceptance") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;

const ISSUE_QUERY = `query LifecycleIssue($owner: String!, $name: String!, $number: Int!, $baseRef: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    ref(qualifiedName: $baseRef) { target { oid } }
    issue(number: $number) {
      id number state title body
      labels(first: 50) { nodes { name } pageInfo { hasNextPage } }
      blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } pageInfo { hasNextPage } }
      comments(last: 100) { nodes { id body createdAt author { login } } pageInfo { hasPreviousPage hasNextPage } }
      projectItems(first: 20) { nodes { ${ITEM_SELECTION} } pageInfo { hasNextPage } }
    }
  }
}`;

const SET_STATUS = `mutation LifecycleSetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

const ADD_COMMENT = `mutation LifecycleAddComment($id: ID!, $body: String!) {
  addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { id url } } }
}`;

// Aliases are built from refs that already passed isRepoName / integer parsing.
function prerequisitesQuery(refs) {
  const parts = refs.map((ref, i) => {
    const { repo, number } = splitRef(ref);
    const [owner, name] = repo.split("/");
    return `d${i}: repository(owner: "${owner}", name: "${name}") { issue(number: ${number}) { number state projectItems(first: 20) { nodes { ${ITEM_SELECTION} } pageInfo { hasNextPage } } comments(last: 50) { nodes { body createdAt author { login } } pageInfo { hasPreviousPage hasNextPage } } } }`;
  });
  return `query LifecyclePrereqs {\n  ${parts.join("\n  ")}\n}`;
}

const refuse = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function createLifecycle({ gate, config, env = process.env, now = Date.now, maxSnapshotAgeMs = DEFAULT_MAX_SNAPSHOT_AGE_MS } = {}) {
  if (!gate || typeof gate.session !== "function") throw new TypeError("createLifecycle needs a gate with session()");
  const { owner: repoOwner, name: repoName, integrationBranch } = config.repository;
  const thisRepo = `${repoOwner}/${repoName}`;
  const trusted = [repoOwner];

  // A read that is cached or old cannot support a consequential transition.
  async function liveRead(ops, args) {
    const result = await ops.read(args);
    if (!result.ok) return result;
    if (result.fromCache === true || (Number.isFinite(result.ageMs) && result.ageMs > maxSnapshotAgeMs)) {
      return refuse("STALE_READ", "the read was cached or too old; consequential transitions need a fresh read");
    }
    return result;
  }

  const boardItemFor = (items) => items.find((item) => item.project?.number === config.project.number && item.project?.owner?.login === config.project.owner) ?? null;

  function authoritativeProject(repo) {
    if (repo === thisRepo) return { owner: config.project.owner, number: config.project.number };
    return (config.crossRepoPrerequisites ?? []).find((entry) => entry.repository === repo)?.project ?? null;
  }

  async function checkPrerequisites(ops, refs, blockers) {
    const checked = [];
    const usable = [];
    for (const ref of refs) {
      const { repo, number } = splitRef(ref);
      if (!isRepoName(repo) || !Number.isInteger(number) || number < 1) {
        blockers.push({ code: "DEPENDENCIES_UNPARSEABLE", message: `"${ref}" is not a valid issue reference` });
        continue;
      }
      if (!authoritativeProject(repo)) {
        blockers.push({ code: "CROSS_REPO_PROJECT_UNKNOWN", message: `${ref} is in another repository and config.json names no authoritative Project for ${repo}` });
        continue;
      }
      usable.push(ref);
    }
    if (usable.length === 0) return checked;
    const result = await liveRead(ops, { query: prerequisitesQuery(usable) });
    if (!result.ok) return result;
    usable.forEach((ref, i) => {
      const { repo, number } = splitRef(ref);
      const project = authoritativeProject(repo);
      const node = result.data[`d${i}`]?.issue;
      if (!node) {
        blockers.push({ code: "PREREQ_NOT_FOUND", message: `prerequisite ${ref} could not be found` });
        return;
      }
      const item = node.projectItems.nodes.find((it) => it.project?.number === project.number && it.project?.owner?.login === project.owner);
      const status = item?.status?.name ?? null;
      const closed = node.state === "CLOSED";
      const done = status === "Done";
      const accepted = hasCompletionRecord(node.comments.nodes, number, [repo.split("/")[0]]);
      checked.push({ ref, state: node.state, status, done, accepted });
      if (!closed) blockers.push({ code: "PREREQ_NOT_CLOSED", message: `${ref} is still open${done ? " although its board status is Done" : ""}` });
      if (!done) blockers.push({ code: "PREREQ_NOT_DONE", message: `${ref} is ${closed ? "closed" : "open"} but is not Done on Project ${project.owner}/${project.number} (status: ${status ?? "not on that board"})` });
      if (!accepted) {
        const why = node.comments.pageInfo.hasPreviousPage ? "; older comments were not fetched, so its acceptance record may be on a page not seen" : "";
        blockers.push({ code: "PREREQ_NO_ACCEPTANCE", message: `${ref} has no recorded acceptance (a complete:v1 comment by the repository owner)${why}` });
      }
    });
    return checked;
  }

  // One live read of the issue (and, unless `light`, its prerequisites), judged
  // against the Ready gates. Pure with respect to GitHub state: no writes.
  async function evaluate(ops, number, { light = false } = {}) {
    const read = await liveRead(ops, {
      query: ISSUE_QUERY,
      variables: { owner: repoOwner, name: repoName, number, baseRef: `refs/heads/${integrationBranch}` },
    });
    if (!read.ok) return read;
    const repository = read.data?.repository;
    const node = repository?.issue;
    if (!node) return refuse("ISSUE_NOT_FOUND", `issue #${number} was not found in ${thisRepo}`);

    const labels = node.labels.nodes.map((l) => l.name);
    const native = [...new Set(node.blockedBy.nodes.map((b) => `${b.repository.nameWithOwner}#${b.number}`))];
    const item = boardItemFor(node.projectItems.nodes);
    const status = item?.status?.name ?? null;
    const blockers = [];

    const contract = parseContract(node.body);
    blockers.push(...contract.problems);

    const acceptanceText = contract.sections.Acceptance;
    let acceptanceClass = null;
    if (acceptanceText) {
      const parsed = parseAcceptanceClass(acceptanceText, config.routing.acceptanceClasses);
      if (parsed.ok) acceptanceClass = parsed.value;
      if (!parsed.ok) blockers.push({ code: "ACCEPTANCE_CLASS", message: parsed.message });
      else if (item && item.acceptance?.name !== parsed.value) {
        blockers.push({ code: "ACCEPTANCE_MISMATCH", message: `the issue says ${parsed.value} but the board's Acceptance field is ${item.acceptance?.name ?? "empty"}` });
      }
    }

    const routing = evaluateRouting(labels, config.routing);
    blockers.push(...routing.problems);

    let declared = null;
    let refs = native;
    if (contract.sections.Dependencies) {
      const parsed = parseDependencies(contract.sections.Dependencies, thisRepo);
      if (!parsed.ok) {
        blockers.push({ code: "DEPENDENCIES_UNPARSEABLE", message: parsed.message });
      } else {
        declared = parsed.refs;
        refs = [...new Set([...declared, ...native])];
        const differs = declared.filter((r) => !native.includes(r)).concat(native.filter((r) => !declared.includes(r)));
        if (differs.length > 0) {
          blockers.push({ code: "DEPENDENCY_MISMATCH", message: `the Dependencies section and the native blocked-by links disagree on: ${differs.join(", ")}` });
        }
      }
    }

    let prerequisites = [];
    if (!light) {
      if (refs.length > MAX_PREREQUISITES) {
        blockers.push({ code: "PREREQ_TOO_MANY", message: `more than ${MAX_PREREQUISITES} prerequisites; split the issue` });
      } else if (refs.length > 0) {
        const checked = await checkPrerequisites(ops, refs, blockers);
        if (checked.ok === false) return checked;
        prerequisites = checked;
      }
    }

    const claims = parseClaims(node.comments.nodes, number, { endAuthors: trusted });
    const promotable = node.state === "OPEN" && item !== null && PROMOTABLE.includes(status);
    return {
      ok: true,
      issue: { id: node.id, number: node.number, title: node.title, state: node.state },
      status,
      boardItem: item,
      labels,
      routing: { profile: routing.profile, effort: routing.effort, escalation: routing.escalation },
      contractSections: Object.keys(contract.sections),
      acceptanceClass,
      startingBaseline: contract.sections["Starting baseline"] ?? "",
      dependencies: { declared, native, prerequisites },
      claims,
      claimHistoryComplete: !node.comments.pageInfo.hasPreviousPage,
      comments: node.comments.nodes,
      baseline: { ref: integrationBranch, oid: repository.ref?.target?.oid ?? null },
      blockers,
      readyToPromote: blockers.length === 0 && promotable,
    };
  }

  const setStatus = (ops, snap, name) =>
    ops.mutate({
      query: SET_STATUS,
      variables: { project: config.project.nodeId, item: snap.boardItem.id, field: config.fields.Status.id, option: config.fields.Status.options[name] },
    });

  const addComment = (ops, snap, body) => ops.mutate({ query: ADD_COMMENT, variables: { id: snap.issue.id, body } });

  // Comment first, then status. Neither is replayed blindly: a failed or uncertain
  // comment stops before the status write, and a failed status write after a
  // posted comment is reported as PARTIAL_WRITE so a re-run (which re-reads)
  // finishes the status without a second comment.
  async function commentThenStatus(ops, snap, { body, statusName, opName = "claim" }) {
    const posted = await addComment(ops, snap, body);
    if (!posted.ok) return { ...posted, step: "comment", commentPosted: false, nextStep: `re-run ${opName}; it re-reads before writing` };
    const status = await setStatus(ops, snap, statusName);
    if (!status.ok) {
      return refuse("PARTIAL_WRITE", `the comment was posted but the Status write failed (${status.code}); re-run to finish the status without a second comment`, {
        commentPosted: true, statusSet: false, cause: status.code, nextStep: "re-run the same command; it will only set the status",
      });
    }
    return { ok: true, commentUrl: posted.data?.addComment?.commentEdge?.node?.url ?? null };
  }

  // ---- inspect -----------------------------------------------------------

  async function inspect(number) {
    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number);
      if (!snap.ok) return snap;
      const { boardItem, comments, ...rest } = snap;
      // Comments are stripped on purpose: expose only the sanitized fields the
      // dispatcher needs to discover a recorded review and an independent check.
      const reviewMarked = markedComments(comments, "review", number, { authors: trusted }).at(-1);
      const review = reviewMarked ? { ...parseReviewComment(reviewMarked.comment.body), index: reviewMarked.index } : null;
      const implementing = snap.claims.claims.map((c) => c.executionId).filter(Boolean);
      for (const { comment } of markedComments(comments, "review", number)) {
        const id = parseReviewComment(comment.body).executionId;
        if (id) implementing.push(id);
      }
      const independentVerification = review?.commit
        ? findIndependentVerification(comments, number, review.index, review.commit, implementing, trusted)
        : false;
      return { ...rest, op: "inspect", boardItemId: boardItem?.id ?? null, review, independentVerification };
    });
  }

  // ---- ready -------------------------------------------------------------

  function promotionRefusal(snap) {
    if (snap.issue.state !== "OPEN") return refuse("ISSUE_CLOSED", `#${snap.issue.number} is closed`);
    if (!snap.boardItem) return refuse("NOT_ON_BOARD", `#${snap.issue.number} is not an item on Project ${config.project.owner}/${config.project.number}`);
    if (!PROMOTABLE.includes(snap.status)) {
      return refuse("STATUS_NOT_PROMOTABLE", `status ${snap.status ?? "none"} cannot be promoted to Ready (only ${PROMOTABLE.join(", ")}; triage Inbox work to Backlog first)`);
    }
    return null;
  }

  async function ready(number, { dryRun = false } = {}) {
    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number);
      if (!snap.ok) return snap;
      const refusal = promotionRefusal(snap);
      if (refusal) return refusal;
      if (snap.blockers.length > 0) {
        return refuse("NOT_READY", `#${number} is not ready: ${snap.blockers.map((b) => b.code).join(", ")}`, { blockers: snap.blockers });
      }
      const changed = snap.status !== "Ready";
      if (dryRun) return { ok: true, op: "ready", dryRun: true, wouldSet: "Ready", changed, status: snap.status };
      if (!changed) return { ok: true, op: "ready", changed: false, status: "Ready" };
      const written = await setStatus(ops, snap, "Ready");
      if (!written.ok) return written;
      return { ok: true, op: "ready", changed: true, status: "Ready", previous: snap.status };
    });
  }

  // ---- claim -------------------------------------------------------------

  function claimFacts(opts) {
    const id = resolveExecutionId({ flag: opts.executionId, env });
    if (!id.ok) return id;
    if (typeof opts.branch !== "string" || !opts.branch.trim() || opts.branch.trim() === integrationBranch || opts.branch.trim() === `origin/${integrationBranch}`) {
      return refuse("BRANCH_INVALID", `a claim needs a working branch other than ${integrationBranch}`);
    }
    if (typeof opts.startCommit !== "string" || !/^[0-9a-f]{7,40}$/i.test(opts.startCommit.trim())) {
      return refuse("START_COMMIT_INVALID", "the starting commit must be a 7 to 40 character hex id");
    }
    if (typeof opts.model !== "string" || !opts.model.trim()) return refuse("MODEL_MISSING", "state the exact model id this run is using");
    if (!config.routing.efforts.includes(opts.effort)) return refuse("EFFORT_INVALID", `effort must be one of ${config.routing.efforts.join(", ")}`);
    const effective = effectiveEffort(opts.effort, config.routing);
    if (!effective) return refuse("EFFORT_INVALID", `effort:${opts.effort} has no runner effective effort defined`);
    if (opts.effectiveEffort !== undefined && String(opts.effectiveEffort).trim() !== effective) {
      return refuse("EFFECTIVE_EFFORT_MISMATCH", `the runner's effective effort for effort:${opts.effort} is ${effective}, not ${opts.effectiveEffort}; record the real effective effort`);
    }
    const worktree = (opts.worktree ?? "").trim() || "not recorded";
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|~)/.test(worktree)) {
      return refuse("WORKTREE_PATH_PRIVATE", "this repository is public; name the worktree (for example ../quiz-name), do not give an absolute local path");
    }
    return {
      ok: true, executionId: id.executionId, branch: opts.branch.trim(), startCommit: opts.startCommit.trim().toLowerCase(),
      model: opts.model.trim(), effort: opts.effort, effectiveEffort: effective, worktree, owner: (opts.owner ?? repoOwner).trim(), allowMismatch: (opts.allowMismatch ?? "").trim(),
    };
  }

  function routingMismatch(facts, snap) {
    const profile = snap.routing.profile && config.routing.profiles[snap.routing.profile];
    const problems = [];
    if (profile && facts.model !== profile.modelId) problems.push(`model ${facts.model} is not ${profile.modelId} (model:${snap.routing.profile})`);
    if (snap.routing.effort && facts.effort !== snap.routing.effort) problems.push(`effort ${facts.effort} is not effort:${snap.routing.effort}`);
    return problems;
  }

  async function claim(number, opts = {}) {
    const facts = claimFacts(opts);
    if (!facts.ok) return facts;
    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number);
      if (!snap.ok) return snap;
      if (snap.issue.state !== "OPEN") return refuse("ISSUE_CLOSED", `#${number} is closed`);
      if (!snap.boardItem) return refuse("NOT_ON_BOARD", `#${number} is not an item on Project ${config.project.owner}/${config.project.number}`);
      if (!snap.claimHistoryComplete) {
        return refuse("CLAIM_HISTORY_INCOMPLETE", "older comments were not fetched, so a live claim could be hidden; refusing to claim");
      }

      const live = snap.claims.live;
      if (live && live.executionId !== facts.executionId) {
        return refuse("CLAIM_HELD", `#${number} already has a live claim by ${live.executionId ?? "an execution whose id cannot be read"}`, { heldBy: live.executionId, claimComment: live.commentId });
      }
      if (live && snap.status === "In progress") {
        return { ok: true, op: "claim", claimed: false, alreadyClaimed: true, status: "In progress" };
      }
      if (snap.status !== "Ready") {
        return refuse("NOT_READY_STATUS", `claim needs Status Ready (it is ${snap.status ?? "none"}); run ready first`);
      }
      if (snap.blockers.length > 0) {
        return refuse("NOT_READY", `#${number} no longer passes the Ready gates: ${snap.blockers.map((b) => b.code).join(", ")}`, { blockers: snap.blockers });
      }

      if (live) {
        // Our own claim comment exists but the status write never landed.
        const written = await setStatus(ops, snap, "In progress");
        if (!written.ok) return { ...written, step: "status" };
        return { ok: true, op: "claim", claimed: false, reconciled: true, status: "In progress" };
      }

      const mismatches = routingMismatch(facts, snap);
      if (mismatches.length > 0 && !facts.allowMismatch) {
        return refuse("ROUTING_MISMATCH", `this run does not match the issue's routing: ${mismatches.join("; ")}. Fix the run, or pass --allow-mismatch with a written reason`, { mismatches });
      }
      // --allow-mismatch can record a supported model that differs from the
      // labels, but it can never authorize a model the routing policy does not
      // define. This keeps an arbitrary or retired coding model from being
      // smuggled in behind a nonempty mismatch reason.
      const supportedModels = new Set(Object.values(config.routing.profiles).map((p) => p.modelId));
      if (facts.allowMismatch && !supportedModels.has(facts.model)) {
        return refuse("MODEL_UNSUPPORTED", `--allow-mismatch cannot authorize an unsupported coding model (${facts.model}); supported models are ${[...supportedModels].join(", ")}`);
      }

      const body = renderClaimComment({
        repo: thisRepo, number, executionId: facts.executionId, owner: facts.owner, model: facts.model, effort: facts.effort, effectiveEffort: facts.effectiveEffort,
        labels: { model: `model:${snap.routing.profile}`, effort: `effort:${snap.routing.effort}` },
        startCommit: facts.startCommit, branch: facts.branch, worktree: facts.worktree,
        mismatch: mismatches.length > 0 ? `${facts.allowMismatch} (${mismatches.join("; ")})` : "",
        nowIso: new Date(now()).toISOString(), baselineOid: snap.baseline.oid,
      });
      const written = await commentThenStatus(ops, snap, { body, statusName: "In progress" });
      if (!written.ok) return written;
      return { ok: true, op: "claim", claimed: true, status: "In progress", commentUrl: written.commentUrl };
    });
  }

  // ---- block -------------------------------------------------------------

  function blockFacts(opts) {
    const text = (value) => (typeof value === "string" ? value.trim() : "");
    if (!text(opts.cause) || !text(opts.needs)) {
      return refuse("BLOCK_REASON_REQUIRED", "a block records both the cause and the decision or evidence needed");
    }
    let executionId = null;
    if (opts.executionId !== undefined) {
      const id = resolveExecutionId({ flag: opts.executionId, env });
      if (!id.ok) return id;
      executionId = id.executionId;
    }
    const change = text(opts.routingChange);
    if (change) {
      const known = [
        ...Object.keys(config.routing.profiles).map((p) => `model:${p}`),
        ...config.routing.efforts.map((e) => `effort:${e}`),
      ];
      if (!known.includes(change)) return refuse("ROUTING_CHANGE_UNKNOWN", `${change} is not defined by the routing policy (${known.join(", ")})`);
      const j = opts.justification ?? {};
      const missing = ["attemptedChecks", "failure", "remainingRisk", "nextScope"].filter((key) => !text(j[key]));
      if (missing.length > 0) {
        return refuse("ROUTING_JUSTIFICATION_REQUIRED", `a routing change needs a written justification; missing: ${missing.join(", ")}`, { missing });
      }
    }
    return {
      ok: true, cause: text(opts.cause), needs: text(opts.needs), executionId, routingChange: change || null,
      justification: opts.justification ?? null,
    };
  }

  async function block(number, opts = {}) {
    const facts = blockFacts(opts);
    if (!facts.ok) return facts;
    return gate.session(async (ops) => {
      const snap = await evaluate(ops, number, { light: true });
      if (!snap.ok) return snap;
      if (snap.issue.state !== "OPEN") return refuse("ISSUE_CLOSED", `#${number} is closed`);
      if (!snap.boardItem) return refuse("NOT_ON_BOARD", `#${number} is not an item on Project ${config.project.owner}/${config.project.number}`);
      if (snap.status === "Done") return refuse("STATUS_NOT_BLOCKABLE", "a Done issue cannot be blocked");

      const sameCause = latestBlockCause(snap.comments, number) === facts.cause.replace(/\s+/g, " ");
      if (sameCause && snap.status === "Blocked") return { ok: true, op: "block", alreadyBlocked: true, status: "Blocked" };
      if (sameCause) {
        const written = await setStatus(ops, snap, "Blocked");
        if (!written.ok) return { ...written, step: "status" };
        return { ok: true, op: "block", reconciled: true, status: "Blocked" };
      }
      const body = renderBlockComment({ number, ...facts, nowIso: new Date(now()).toISOString() });
      const written = await commentThenStatus(ops, snap, { body, statusName: "Blocked", opName: "block" });
      if (!written.ok) return written;
      return { ok: true, op: "block", status: "Blocked", commentUrl: written.commentUrl };
    });
  }

  const finish = createFinish({
    gate, config, env, now, thisRepo, trusted, evaluate, setStatus, addComment, commentThenStatus
  });
  return { inspect, ready, claim, block, ...finish };
}

// ---- command line -----------------------------------------------------------

export function helpText() {
  return `Roadmap lifecycle wrapper, part 1 (issue #3)

  node scripts/roadmap/lifecycle.mjs <op> <issue> [--json] [flags]

Operations
  inspect <n>   read-only report: contract, routing, dependencies, claims, baseline
  ready <n>     re-read live state, verify every Ready gate, then set Status Ready
                  --dry-run   verify and report; never write
  claim <n>     under one lock: re-check Ready, refuse another live claim, post the
                claim:v1 comment, set In progress
                  --execution-id <id>   this run's own id (required; must equal the
                                        runner's own CODEX_THREAD_ID, or the legacy
                                        CLAUDE_CODE_SESSION_ID when no Codex id is set)
                  --branch <name> --start-commit <sha> --model <id>
                  --effort <low|medium|high>   (default: CLAUDE_EFFORT)
                  --effective-effort <low|high>  the runner's real effort; validated
                                        against the mapping and recorded separately
                  --worktree <name>   a name such as ../quiz-x, never an absolute path
                  --allow-mismatch <reason>   record a run that differs from the labels
  review <n>    claim holder records the tested commit, commands, exclusions and
                outstanding steps (review:v1), then Status In review
                  --execution-id --commit --commands --exclusions --outstanding
                  [--artifacts] [--branch] [--external-evidence (required for External)]
  verify <n>    an execution other than the implementer records an independent check
                  --execution-id --commit --checks
  complete <n>  verify acceptance for the issue's class, check the commit is reachable
                from main (or a special branch recorded on the issue), then write the
                complete:v1 comment, Done and the close together, and re-read
                  [--special-branch <name>]
  stale <n>     read-only: compare issue state, board status and claim records
  release <n>   restart a stale claim ONLY on recorded operator evidence (age is never proof)
                  --stopped-execution <id> --confirmed-by <name> --evidence <text>
  block <n>     post a block:v1 comment and set Blocked; scope and priority untouched
                  --cause <text> --needs <text>
                  --routing-change <label> with --attempted-checks --failure
                    --remaining-risk --next-scope (all required). The wrapper records
                    the proposal; the owner changes labels.

Exit codes: 0 done, 1 refused (the code and reason are printed), 2 bad usage.

Honest limits
  A lock plus a re-read is not an atomic claim across hosts. The lock covers
  cooperating processes on one host only. With several people or hosts, use one
  dispatcher (see docs/PROJECT_OPERATING_PLAYBOOK.md section 4 and issue #4).
  Acceptance by the owner is a comment from the owner account; anything that can post
  as that account can type it, so a bare self-report is never accepted as verification.
`;
}

const BOOLEAN_FLAGS = new Set(["json", "dry-run", "help"]);

// "--flag value", "--flag=value"; a repeated flag becomes an array so a
// duplicated --execution-id can be refused instead of silently picking one.
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    let value;
    if (BOOLEAN_FLAGS.has(name)) value = true;
    else if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      i += 1;
    }
    flags[name] = name in flags ? [].concat(flags[name], value) : value;
  }
  return { positional, flags };
}

function render(result, json) {
  if (json) return JSON.stringify(result, null, 2);
  if (!result.ok) {
    const lines = [`REFUSED ${result.code}: ${result.message}`];
    for (const b of result.blockers ?? []) lines.push(`  - ${b.code}: ${b.message}`);
    if (result.retryAt) lines.push(`  next allowed attempt: ${result.retryAt}`);
    if (result.nextStep) lines.push(`  next: ${result.nextStep}`);
    return lines.join("\n");
  }
  if (result.op === "inspect") {
    const lines = [
      `#${result.issue.number} ${result.issue.title} [${result.issue.state}] status=${result.status ?? "not on board"}`,
      `routing: model:${result.routing.profile ?? "?"} effort:${result.routing.effort ?? "?"}${result.routing.escalation ? " (escalation:opus on record)" : ""}`,
      `dependencies: declared=${JSON.stringify(result.dependencies.declared)} native=${JSON.stringify(result.dependencies.native)}`,
      ...result.dependencies.prerequisites.map((p) => `  ${p.ref}: ${p.state}, ${p.status ?? "no status"}, acceptance ${p.accepted ? "recorded" : "NOT recorded"}`),
      `claims: ${result.claims.claims.length} on record, live: ${result.claims.live ? result.claims.live.executionId ?? "unreadable id" : "none"}${result.claimHistoryComplete ? "" : " (history incomplete)"}`,
      `baseline: ${result.baseline.ref} @ ${result.baseline.oid ?? "unknown"}`,
      result.blockers.length === 0 ? "blockers: none" : `blockers:\n${result.blockers.map((b) => `  - ${b.code}: ${b.message}`).join("\n")}`,
      `ready to promote: ${result.readyToPromote ? "yes" : "no"}`,
    ];
    return lines.join("\n");
  }
  if (result.op === "stale") {
    const claim = result.liveClaim ? `${result.liveClaim.executionId ?? "unreadable id"} (age ${result.liveClaim.ageHours ?? "?"}h, not evidence)` : "none live";
    const found = result.discrepancies.length === 0 ? "discrepancies: none" : ["discrepancies:", ...result.discrepancies.map((d) => `  - ${d.code}: ${d.message}`)].join("\n");
    return [`claim: ${claim}`, found, result.note].join("\n");
  }
  return `OK ${JSON.stringify(result)}`;
}

export async function runCli(argv, { lifecycle, env = process.env, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [op, rawNumber] = positional;
  if (flags.help || !op || op === "help") {
    out(helpText());
    return op || flags.help ? 0 : 2;
  }
  const number = Number(rawNumber);
  if (!["inspect", "ready", "claim", "block", "review", "verify", "complete", "stale", "release"].includes(op) || !Number.isInteger(number) || number < 1) {
    out(`usage error: expected <inspect|ready|claim|block|review|verify|complete|stale|release> <issue number>\n\n${helpText()}`);
    return 2;
  }
  const effort = flags.effort ?? env.CLAUDE_EFFORT;
  let result;
  if (op === "inspect") result = await lifecycle.inspect(number);
  else if (op === "ready") result = await lifecycle.ready(number, { dryRun: Boolean(flags["dry-run"]) });
  else if (op === "claim") {
    result = await lifecycle.claim(number, {
      executionId: flags["execution-id"], branch: flags.branch, startCommit: flags["start-commit"], model: flags.model,
      effort, effectiveEffort: flags["effective-effort"], worktree: flags.worktree, owner: flags.owner, allowMismatch: flags["allow-mismatch"],
    });
  } else if (op === "review") {
    result = await lifecycle.review(number, {
      executionId: flags["execution-id"], commit: flags.commit, commands: flags.commands, artifacts: flags.artifacts,
      exclusions: flags.exclusions, outstanding: flags.outstanding, externalEvidence: flags["external-evidence"], branch: flags.branch,
    });
  } else if (op === "verify") {
    result = await lifecycle.verify(number, { executionId: flags["execution-id"], commit: flags.commit, checks: flags.checks });
  } else if (op === "complete") {
    result = await lifecycle.complete(number, { specialBranch: flags["special-branch"] });
  } else if (op === "stale") {
    result = await lifecycle.stale(number);
  } else if (op === "release") {
    result = await lifecycle.release(number, { stoppedExecution: flags["stopped-execution"], confirmedBy: flags["confirmed-by"], evidence: flags.evidence });
  } else {
    result = await lifecycle.block(number, {
      cause: flags.cause, needs: flags.needs, executionId: flags["execution-id"], routingChange: flags["routing-change"],
      justification: { attemptedChecks: flags["attempted-checks"], failure: flags.failure, remainingRisk: flags["remaining-risk"], nextScope: flags["next-scope"] },
    });
  }
  out(render(result, Boolean(flags.json)));
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const config = JSON.parse(fs.readFileSync(new URL("../../docs/roadmap/config.json", import.meta.url), "utf8"));
  const gate = createGate({ transport: createGhTransport() });
  const lifecycle = createLifecycle({ gate, config });
  runCli(process.argv.slice(2), { lifecycle }).then((code) => { process.exitCode = code; });
}
