// DeepSeek batch dispatcher (issue #51): a small, on-request, sequential runner.
//
// It is the one dispatcher for the host. It reuses scripts/roadmap/gate.mjs for
// every repo-owned GitHub read/write and spawns git, npm and codex here (tools/
// is outside scripts/, which the bypass check forbids from importing
// child_process). Private run state, logs and the host-local batch lock live
// outside git, in owner-only files.
//
//   node tools/codex-batch.mjs --dry-run            plan only; no writes, no model API
//   node tools/codex-batch.mjs --sole-dispatcher [--resume] [--issues 13..44]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createGate } from "../scripts/roadmap/gate.mjs";
import { createGhTransport } from "../scripts/roadmap/github-transport.mjs";
import { createLifecycle } from "../scripts/roadmap/lifecycle.mjs";
import { parseClaims, resolveOwnExecutionId, sameCommit } from "../scripts/roadmap/lifecycle-core.mjs";
import { acquireLock } from "../scripts/roadmap/lock.mjs";
import {
  DEFAULT_ATTEMPTS, DEFAULT_BATCH_DEADLINE_MS, DEFAULT_BUDGET_USD, branchName,
  budgetAllowsNext, headMatchesReviewed, migrationAllocation, parseDeepseekBalance,
  renderPrBody, renderSolPrompt, renderWorkerPrompt, routeIssue, selectEligibleIssues,
  sessionSpendUsd, sortIssues, validateBalance, verifyInvalidated, worktreeName,
} from "./batch-core.mjs";

const CONFIG_URL = new URL("../docs/roadmap/config.json", import.meta.url);
const DEEPSEEK_KEY_PATH = path.join(os.homedir(), ".codex", "deepseek-api-key");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "share", "brainstorm-batch");
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const PB_MIN = 13;
const PB_MAX = 44;

const ITEM = `project { number owner { ... on User { login } ... on Organization { login } } }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  acceptance: fieldValueByName(name: "Acceptance") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;

const ISSUE = `number state title body
  labels(first: 30) { nodes { name } pageInfo { hasNextPage } }
  comments(last: 50) { nodes { body createdAt author { login } } pageInfo { hasPreviousPage } }
  projectItems(first: 5) { nodes { ${ITEM} } pageInfo { hasNextPage } }`;

function scanQuery(owner, name, numbers) {
  const parts = numbers.map((n) => `i${n}: issue(number: ${n}) { ${ISSUE} }`);
  return `query BatchScan { repository(owner: "${owner}", name: "${name}") { ${parts.join(" ")} } }`;
}

function normalizeIssue(config, node, number) {
  node = node ?? {};
  const labels = (node.labels?.nodes ?? []).map((l) => l.name);
  const item = (node.projectItems?.nodes ?? []).find(
    (it) => it.project?.number === config.project.number && it.project?.owner?.login === config.project.owner,
  );
  const live = parseClaims(node.comments?.nodes ?? [], number, { endAuthors: [config.repository.owner] }).live;
  return {
    number,
    title: node.title,
    body: node.body,
    state: node.state,
    status: item?.status?.name ?? null,
    acceptance: item?.acceptance?.name ?? null,
    priority: item?.priority?.name ?? null,
    labels,
    liveClaim: live ? live.executionId ?? "unreadable" : null,
    kind: /goal/i.test(node.title) || labels.includes("goal") ? "goal" : "implementation",
  };
}

function parseNumbers(value) {
  if (!value) return Array.from({ length: PB_MAX - PB_MIN + 1 }, (_, i) => PB_MIN + i);
  const out = [];
  for (const part of String(value).split(",")) {
    const range = /^(\d+)\.\.(\d+)$/.exec(part.trim());
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n += 1) out.push(n);
    } else if (/^\d+$/.test(part.trim())) {
      out.push(Number(part.trim()));
    }
  }
  return out.length ? out : null;
}

export function createBatch({
  config, gate, lifecycle, run, http, env = process.env, now = Date.now,
  stateDir = DEFAULT_STATE_DIR, keyPath = DEEPSEEK_KEY_PATH, lock = { acquire: acquireLock },
} = {}) {
  const owner = config.repository.owner;
  const name = config.repository.name;
  const repo = `${owner}/${name}`;

  const stateFile = () => path.join(stateDir, "run-state.json");
  const lockFile = () => path.join(stateDir, "batch.lock");
  const logFile = () => path.join(stateDir, "batch.log");

  function mkdirs() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  function atomicWrite(file, data, mode) {
    mkdirs();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  }

  // Corrupt or unreadable state fails closed; it is never silently reset.
  function loadState() {
    let raw;
    try {
      raw = fs.readFileSync(stateFile(), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error(`run state is unreadable (${error.message}); refusing to reset it`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("run state is corrupt JSON; refusing to reset it");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("run state is not an object; refusing to reset it");
    return parsed;
  }

  function saveState(state) {
    atomicWrite(stateFile(), JSON.stringify(state, null, 2), 0o600);
  }

  function log(entry) {
    try {
      mkdirs();
      fs.appendFileSync(logFile(), `${new Date(now()).toISOString()} ${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* logging must never break the run */ }
  }

  // The key is read into the worker process environment only; it is never part
  // of a prompt, comment, PR, commit, or public log.
  const loadKey = () => {
    try { return fs.readFileSync(keyPath, "utf8").trim() || null; } catch { return null; }
  };

  async function readBalance(key) {
    if (!key) return { ok: false, reason: "DEEPSEEK_API_KEY is not available" };
    const response = await http(DEEPSEEK_BALANCE_URL, { headers: { Authorization: `Bearer ${key}` } });
    if (!response?.ok) return { ok: false, reason: `balance endpoint returned ${response?.status ?? "no response"}` };
    const parsed = parseDeepseekBalance(response.json);
    if (!parsed) return { ok: false, reason: "balance endpoint returned no usable balance_infos" };
    return validateBalance(parsed);
  }

  async function git(args, { cwd, input } = {}) {
    const result = await run("git", args, { cwd, input });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return String(result.stdout).trim();
  }

  async function discoverRepo() {
    const top = await git(["rev-parse", "--show-toplevel"]);
    const shared = await git(["rev-parse", "--git-common-dir"]);
    return { top: path.resolve(top), shared: path.resolve(shared) };
  }

  async function scanIssues(numbers) {
    const result = await gate.read({ query: scanQuery(owner, name, numbers) });
    if (!result.ok) throw new Error(`scan refused: ${result.code} ${result.message}`);
    const nodes = result.data?.repository ?? {};
    const out = [];
    for (const n of numbers) {
      const node = nodes[`i${n}`];
      if (!node) throw new Error(`issue #${n} is missing from the scan; refusing to proceed`);
      out.push(normalizeIssue(config, node, n));
    }
    return out;
  }

  function select(issues, { minNumber = PB_MIN, maxNumber = PB_MAX, externalAuthorized = new Set() } = {}) {
    return selectEligibleIssues(issues, { minNumber, maxNumber, externalAuthorized });
  }

  // ---- subprocess environment --------------------------------------------

  // Strip the dispatcher's own execution ids so the child Codex generates its
  // own, then record this run as the parent. GH_TOKEN is retained so the child
  // can use the gate; DEEPSEEK_API_KEY is only present for the DeepSeek worker.
  const stripExecutionIds = (base) => {
    const out = { ...base };
    for (const k of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_PARENT_THREAD_ID", "CODEX_PARENT_SESSION_ID"]) {
      delete out[k];
    }
    return out;
  };

  function workerEnv(parentId) {
    const out = stripExecutionIds(env);
    if (parentId) out.CODEX_PARENT_THREAD_ID = parentId;
    return out;
  }

  function solEnv(parentId) {
    const out = stripExecutionIds(env);
    delete out.DEEPSEEK_API_KEY;
    if (parentId) out.CODEX_PARENT_THREAD_ID = parentId;
    return out;
  }

  // The worker gets the key in its process environment only (the DeepSeek
  // profile reads it via env_key). A codex child shell must not inherit it.
  // ponytail: the shell_environment_policy exclusion of DEEPSEEK_API_KEY is not
  // asserted offline; the live rehearsal confirms the exact inherit syntax.
  function workerArgs({ modelId, effectiveEffort, shared }) {
    return [
      "exec", "-p", "deepseek", "--model", modelId,
      "-c", "approval_policy=never",
      "-c", `model_reasoning_effort=${effectiveEffort}`,
      "--sandbox", "workspace-write",
      "--add-dir", shared,
      "--json",
    ];
  }

  function solArgs() {
    return ["exec", "--model", "gpt-6.1-sol", "--json"];
  }

  // ---- publication --------------------------------------------------------

  async function findPullRequest(branch) {
    const result = await gate.rest({ method: "GET", path: `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}` });
    if (!result.ok) return result;
    return { ok: true, pr: Array.isArray(result.data) ? result.data[0] : null };
  }

  async function openPullRequest(branch, title, body) {
    const result = await gate.rest({
      method: "POST", path: `/repos/${repo}/pulls`,
      body: { title, head: `${owner}:${branch}`, base: config.repository.integrationBranch, body },
    });
    if (!result.ok) return result;
    return { ok: true, number: result.data?.number, url: result.data?.html_url, head: result.data?.head };
  }

  async function mergePullRequest(prNumber, reviewedSha) {
    return gate.rest({
      method: "PUT", path: `/repos/${repo}/pulls/${prNumber}/merge`,
      body: { merge_method: "merge", sha: reviewedSha },
    });
  }

  // Push the branch, then read the remote head back through the gate so the
  // dispatcher never trusts its own local checkout.
  async function publishBranch(branch, treePath) {
    await git(["push", "origin", branch], { cwd: treePath });
    const remote = await gate.rest({ method: "GET", path: `/repos/${repo}/branches/${encodeURIComponent(branch)}` });
    if (!remote.ok || !remote.data?.commit?.sha) {
      return { ok: false, code: remote.code ?? "REMOTE_HEAD_UNKNOWN", message: "could not verify the pushed branch's remote head" };
    }
    return { ok: true, remoteSha: remote.data.commit.sha };
  }

  async function publishPullRequest(branch, title, body) {
    const found = await findPullRequest(branch);
    if (!found.ok) return found;
    if (found.pr) return { ok: true, pr: found.pr, number: found.pr.number };
    const opened = await openPullRequest(branch, title, body);
    if (!opened.ok) return opened;
    // Adopt the creation response; never leave `pr` empty on a new PR.
    const refetched = await findPullRequest(branch);
    if (!refetched.ok || !refetched.pr) return { ok: false, code: refetched.code ?? "PR_NOT_FOUND", message: "created the PR but could not refetch it" };
    return { ok: true, pr: refetched.pr, number: refetched.pr.number };
  }

  // ---- one ticket ---------------------------------------------------------

  async function runTicket(ticket, state, ctx) {
    const number = ticket.number;
    let rec = state.issues?.[number] ?? null;
    const attempts = rec?.attempts ?? 0;

    const routing = routeIssue(ticket.labels, config.routing);
    if (routing.problems.length > 0) return { blocked: true, code: "ROUTING", problems: routing.problems };
    if (ticket.acceptance === "External" && !ctx.externalAuthorized.has(number)) return { skipped: true, acceptance: "External" };
    // An owned in-flight ticket is resumable even though its live status is no
    // longer Ready/Backlog; every other status is out of scope.
    const owned = rec && ["claimed", "worked", "rework", "reviewed"].includes(rec.phase);
    const allowed = owned ? ["Ready", "Backlog", "In progress", "In review"] : ["Ready", "Backlog"];
    if (!allowed.includes(ticket.status)) return { skipped: true, status: ticket.status };

    if (attempts >= ctx.maxAttempts) return { blocked: true, code: "ATTEMPTS_EXHAUSTED" };

    // Migration allocation must already be written into the contract; the
    // dispatcher never guesses a number.
    const migration = migrationAllocation(ticket.body);
    if (migration && !migration.allocated) {
      return { blocked: true, code: "MIGRATION_NUMBER_MISSING", message: "the issue declares a migration but no number is assigned; Matthew assigns it" };
    }

    // Backlog promotion: a failing Ready gate leaves the ticket in Backlog; it is
    // not blanket-marked Blocked just because a dependency is not done.
    if (ticket.status === "Backlog") {
      const promoted = await lifecycle.ready(number);
      if (!promoted.ok) return { blocked: true, code: promoted.code, leftBacklog: true, blockers: promoted.blockers };
    }

    const key = loadKey();
    if (!key) return { stopped: true, reason: "no DeepSeek API key" };
    const before = await readBalance(key);
    if (!before.ok) return { stopped: true, reason: before.reason };
    if (state.startUsd !== undefined && before.total > state.startUsd + 1e-9) {
      return { stopped: true, reason: "balance increased above the batch start balance; stopping" };
    }

    const repoInfo = await discoverRepo();
    const top = repoInfo.top;

    // Reuse the persisted branch/worktree on resume/rework; never create a new one.
    let branch, treePath, worktreeNameValue;
    if (rec?.branch && rec?.worktree) {
      branch = rec.branch;
      worktreeNameValue = rec.worktree;
      treePath = path.resolve(top, "..", rec.worktree.replace(/^\.\.\//, ""));
    } else {
      const runNumber = attempts + 1;
      branch = branchName(number, runNumber);
      worktreeNameValue = worktreeName(number, runNumber);
      treePath = path.resolve(top, "..", `quiz-pb-${number}-${runNumber}`);
      await git(["fetch", "origin", "main"], { cwd: top });
      const baseSha = await git(["rev-parse", "origin/main"], { cwd: top });
      await git(["worktree", "add", treePath, "-b", branch, baseSha], { cwd: top });
      const install = await run("npm", ["ci"], { cwd: treePath });
      if (install.status !== 0) return { blocked: true, code: "INSTALL_FAILED" };
      rec = { number, phase: "claimed", branch, worktree: worktreeNameValue, attempts: 0, executionId: null, sessionId: null, prNumber: null, reviewSha: null, verification: null, startedChildPid: null };
      state.issues = state.issues ?? {};
      state.issues[number] = rec;
      saveState(state);
    }

    const baseSha = await git(["rev-parse", "origin/main"], { cwd: top });
    const claimCommand = [
      "node scripts/roadmap/lifecycle.mjs claim", number,
      "--execution-id \"$CODEX_THREAD_ID\"",
      `--branch ${branch}`,
      `--start-commit ${baseSha}`,
      `--model ${routing.modelId}`,
      `--effort ${routing.effort}`,
      `--effective-effort ${routing.effectiveEffort}`,
      `--worktree ${worktreeNameValue}`,
    ].join(" ");

    const prompt = renderWorkerPrompt({
      number, title: ticket.title, body: ticket.body, branch, worktree: worktreeNameValue, startCommit: baseSha,
      modelId: routing.modelId, profile: routing.profile, logicalEffort: routing.effort, effectiveEffort: routing.effectiveEffort,
      claimCommand, rework: ctx.rework?.[number] ?? undefined,
    });

    const deadlineLeft = ctx.deadlineAtMs - now();
    if (deadlineLeft <= 0) return { stopped: true, reason: "batch deadline reached before launch" };

    const worker = await run("codex", workerArgs({ modelId: routing.modelId, effectiveEffort: routing.effectiveEffort, shared: repoInfo.shared }), {
      cwd: treePath, input: prompt, env: { ...workerEnv(ctx.parentId), DEEPSEEK_API_KEY: key }, timeoutMs: deadlineLeft,
    });
    log({ op: "worker", issue: number, status: worker.status, killed: Boolean(worker.killed), stdoutTail: String(worker.stdout ?? "").slice(-400) });
    if (worker.killed) return { stopped: true, reason: "batch deadline killed the active worker", deadline: true };

    rec.attempts = attempts + 1;
    rec.phase = "worked";
    rec.startedChildPid = worker.pid ?? null;
    rec.sessionId = worker.sessionId ?? rec.sessionId ?? null;
    saveState(state);

    const after = await readBalance(key);
    if (!after.ok) {
      await blockTicket(number, "balance became unreadable after the session", `after-session balance: ${after.reason}`);
      return { stopped: true, reason: after.reason };
    }
    const spend = sessionSpendUsd(before, after);
    if (!spend || spend.increase) {
      await blockTicket(number, "balance increased unexpectedly after the session", "owner to reconcile account spend");
      return { stopped: true, reason: "balance increased unexpectedly; stopping" };
    }
    state.spentUsd = (state.spentUsd ?? 0) + spend.spend;
    state.latestUsd = after.total;
    saveState(state);

    // A non-zero worker exit is a failed session: spend is still persisted, but
    // the run must not proceed to publication. The findings feed the rework.
    if (worker.status !== 0) {
      return await reworkOrBlock(number, ticket, state, rec, `worker exited ${worker.status}: ${String(worker.stdout ?? "").slice(-800)}`, ctx);
    }

    // Discover the recorded review through the sanitized inspect summary (raw
    // comments are intentionally stripped).
    const inspection = await lifecycle.inspect(number);
    if (!inspection.ok) return { blocked: true, code: inspection.code ?? "INSPECT_FAILED" };
    rec.executionId = inspection.claims?.live?.executionId ?? rec.executionId ?? null;
    const reviewedSha = inspection.review?.commit ?? null;
    if (!reviewedSha) return await reworkOrBlock(number, ticket, state, rec, "the worker left no review record", ctx);

    // Publish, then verify, then adopt a PR.
    const pushed = await publishBranch(branch, treePath);
    if (!pushed.ok) return await reworkOrBlock(number, ticket, state, rec, pushed.message ?? "push failed", ctx);
    if (!headMatchesReviewed(pushed.remoteSha, reviewedSha)) {
      return await reworkOrBlock(number, ticket, state, rec, `remote head ${pushed.remoteSha} != reviewed ${reviewedSha}`, ctx);
    }
    const published = await publishPullRequest(branch, `Implement #${number}`, renderPrBody({ number, title: ticket.title, commit: reviewedSha, branch }));
    if (!published.ok) return { blocked: true, code: published.code ?? "PUBLISH_FAILED", message: published.message };
    rec.prNumber = published.number;
    rec.reviewSha = reviewedSha;
    saveState(state);

    // Sol: default provider, no DeepSeek profile/key, its own session, and it
    // records lifecycle.verify only if it passes on the exact remote SHA.
    const verifyCommand = [
      "node scripts/roadmap/lifecycle.mjs verify", number,
      "--execution-id \"$CODEX_THREAD_ID\"",
      `--commit ${reviewedSha}`,
      "--checks \"npm ci && npm test: (paste real output)\"",
    ].join(" ");
    const solPrompt = renderSolPrompt({ number, reviewedSha, branch, verifyCommand });
    const sol = await run("codex", solArgs(), {
      cwd: treePath, input: solPrompt, env: solEnv(ctx.parentId), timeoutMs: ctx.deadlineAtMs - now(),
    });
    log({ op: "sol", issue: number, status: sol.status, killed: Boolean(sol.killed), stdoutTail: String(sol.stdout ?? "").slice(-400) });

    // Acceptance: Sol exit zero is necessary but not sufficient; the exact
    // reviewed SHA must carry a fresh independent verification.
    const verifiedInspection = await lifecycle.inspect(number);
    const verification = verifiedInspection.ok ? verifiedInspection.independentVerification === true : false;
    rec.verification = verification;
    saveState(state);
    if (sol.status !== 0 || !verification || !headMatchesReviewed(pushed.remoteSha, reviewedSha)) {
      return await reworkOrBlock(number, ticket, state, rec, `Sol ${sol.status !== 0 ? "failed" : "did not record an independent verification"}: ${String(sol.stdout ?? "").slice(-800)}`, ctx, { solFailure: true });
    }

    if (ticket.acceptance === "Producer") {
      rec.phase = "reviewed";
      saveState(state);
      return { reviewed: true, waiting: "Producer", spendUsd: spend.spend };
    }

    // Merge with the expected SHA in the body to close the head-change race.
    const merged = await mergePullRequest(published.number, reviewedSha);
    if (!merged.ok) return { blocked: true, code: merged.code ?? "MERGE_FAILED", message: merged.message };

    // Test the fetched, merged origin/main in a separate integration worktree,
    // never the caller's arbitrary checkout.
    const integration = await testIntegratedMain(top, reviewedSha);
    if (!integration.ok) return { blocked: true, code: integration.code };

    const completed = await lifecycle.complete(number);
    rec.phase = "done";
    rec.completed = completed.ok;
    saveState(state);
    return { completed: completed.ok, code: completed.ok ? null : completed.code, spendUsd: spend.spend };
  }

  async function blockTicket(number, cause, needs) {
    try {
      const own = resolveOwnExecutionId(env);
      await lifecycle.block(number, { cause, needs, executionId: own.ok ? own.executionId : undefined });
    } catch { /* a failed block must not mask the real stop */ }
  }

  async function reworkOrBlock(number, ticket, state, rec, reason, ctx, extra = {}) {
    const attempts = rec.attempts ?? 0;
    if (attempts < ctx.maxAttempts) {
      ctx.rework = ctx.rework ?? {};
      ctx.rework[number] = reason;
      rec.phase = "rework";
      saveState(state);
      return { rework: true, issue: number, reason };
    }
    await blockTicket(number, "worker could not produce accepted work after the attempt limit", reason);
    rec.phase = "blocked";
    saveState(state);
    return { blocked: true, code: extra.solFailure ? "SOL_REJECTED" : "REWORK_EXHAUSTED", reason };
  }

  async function testIntegratedMain(top, reviewedSha) {
    const dir = path.resolve(top, "..", `quiz-integration-${reviewedSha.slice(0, 7)}`);
    await run("git", ["worktree", "remove", "--force", dir], { cwd: top }); // tolerate a leftover
    await git(["fetch", "origin", "main"], { cwd: top });
    await git(["worktree", "add", "--detach", dir, "origin/main"], { cwd: top });
    const ci = await run("npm", ["ci"], { cwd: dir });
    if (ci.status !== 0) return { ok: false, code: "INTEGRATION_INSTALL_FAILED" };
    const test = await run("npm", ["test"], { cwd: dir });
    if (test.status !== 0) return { ok: false, code: "INTEGRATION_TEST_FAILED" };
    const ancestor = await run("git", ["merge-base", "--is-ancestor", reviewedSha, "origin/main"], { cwd: dir });
    if (ancestor.status !== 0) return { ok: false, code: "COMMIT_NOT_ON_MAIN" };
    await run("git", ["worktree", "remove", "--force", dir], { cwd: top });
    return { ok: true };
  }

  // ---- batch --------------------------------------------------------------

  function validateCliLimits({ budgetUsd, deadlineMs }) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return { ok: false, code: "BUDGET_INVALID", message: "--budget-usd must be a positive number" };
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return { ok: false, code: "DEADLINE_INVALID", message: "--deadline-ms must be a positive number" };
    return { ok: true };
  }

  async function runBatch({ numbers, externalAuthorized = new Set(), budgetUsd = DEFAULT_BUDGET_USD, deadlineMs = DEFAULT_BATCH_DEADLINE_MS, resume = false, parentId = null, soleDispatcher = false } = {}) {
    const limits = validateCliLimits({ budgetUsd, deadlineMs });
    if (!limits.ok) return limits;
    if (!soleDispatcher) return { ok: false, code: "SOLE_DISPATCHER_REQUIRED", message: "a non-dry-run batch needs --sole-dispatcher (it is a host-local lock, not cross-machine)" };

    let acquired = null;
    try {
      acquired = lock.acquire({ lockPath: lockFile(), label: "codex-batch", host: os.hostname(), now });
    } catch {
      acquired = null;
    }
    if (!acquired?.ok) {
      return { ok: false, code: acquired?.code ?? "LOCK_CONTENDED", message: acquired?.message ?? "another batch dispatcher holds the lock", owner: acquired?.owner ?? null };
    }

    try {
      let state;
      try {
        state = loadState();
      } catch (error) {
        return { ok: false, code: "STATE_CORRUPT", message: error.message };
      }
      if (state && !resume && !state.done) {
        return { ok: false, code: "UNRESOLVED_PREVIOUS_BATCH", message: "an unfinished batch exists; pass --resume to continue it" };
      }
      if (resume && !state) return { ok: false, code: "NO_STATE", message: "no persisted run state to resume" };

      const startMs = resume && state.startedAt ? Date.parse(state.startedAt) : now();
      if (!resume || !state) {
        state = {
          batchId: randomUUID(),
          startedAt: new Date(startMs).toISOString(),
          deadlineMs,
          budgetUsd,
          startUsd: undefined,
          latestUsd: undefined,
          spentUsd: 0,
          issues: {},
          done: false,
        };
        saveState(state);
      }
      log({ op: "thread.started", batchId: state.batchId, resume, parentId });

      const issues = await scanIssues(numbers);
      const selected = select(issues, { minNumber: Math.min(...numbers), maxNumber: Math.max(...numbers), externalAuthorized });

      // On resume, owned in-flight tickets must be worked even though they now
      // carry a live claim that selection would otherwise exclude.
      const owned = Object.keys(state.issues ?? {})
        .map((n) => Number(n))
        .filter((n) => {
          const rec = state.issues[n];
          return rec && ["claimed", "worked", "rework", "reviewed"].includes(rec.phase);
        });
      const queue = sortIssues([
        ...selected,
        ...issues.filter((i) => owned.includes(i.number) && !selected.some((s) => s.number === i.number)),
      ]);

      const ctx = {
        externalAuthorized,
        maxAttempts: DEFAULT_ATTEMPTS,
        deadlineAtMs: startMs + deadlineMs,
        parentId,
        rework: {},
      };
      const skipSet = new Set();
      const results = [];

      for (let i = 0; i < queue.length; i += 1) {
        const ticket = queue[i];
        if (skipSet.has(ticket.number)) continue;
        if (now() >= ctx.deadlineAtMs) {
          results.push({ number: ticket.number, stopped: true, reason: "batch deadline reached" });
          break;
        }
        if (!budgetAllowsNext({ spentUsd: state.spentUsd, budgetUsd })) {
          results.push({ number: ticket.number, stopped: true, reason: "budget exhausted" });
          break;
        }
        const result = await runTicket(ticket, state, ctx);
        results.push({ number: ticket.number, ...result });
        saveState(state);
        if (result.rework) queue.push(ticket); // bounded by attempts inside runTicket
        else if (result.blocked || result.waiting) skipSet.add(ticket.number);
        if (result.stopped) break;
      }
      state.done = true;
      saveState(state);
      return { ok: true, op: "batch", batchId: state.batchId, results };
    } finally {
      acquired?.release?.();
    }
  }

  async function dryRun(issues) {
    const selected = [];
    const skipped = [];
    const range = issues.length
      ? { minNumber: Math.min(...issues.map((i) => i.number)), maxNumber: Math.max(...issues.map((i) => i.number)) }
      : { minNumber: PB_MIN, maxNumber: PB_MAX };
    for (const issue of select(issues, range)) {
      const migration = migrationAllocation(issue.body);
      if (migration && !migration.allocated) { skipped.push({ number: issue.number, reason: "MIGRATION_NUMBER_MISSING" }); continue; }
      const ready = await lifecycle.ready(issue.number, { dryRun: true });
      if (!ready.ok) { skipped.push({ number: issue.number, reason: ready.code }); continue; }
      selected.push({ number: issue.number, title: issue.title, status: issue.status, priority: issue.priority, acceptance: issue.acceptance });
    }
    return { ok: true, op: "dry-run", selected, skipped };
  }

  return {
    discoverRepo, scanIssues, select, dryRun, runBatch, runTicket, loadKey, readBalance, loadState, saveState,
    workerArgs, solArgs, workerEnv, solEnv, publishBranch, publishPullRequest, mergePullRequest, testIntegratedMain,
  };
}

// ---- command line ---------------------------------------------------------

const BOOL = new Set(["dry-run", "resume", "help", "json", "sole-dispatcher"]);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = BOOL.has(name) ? true : eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    flags[name] = name in flags ? [].concat(flags[name], value) : value;
  }
  return flags;
}

function realRun(command, args, { cwd, input, env: extraEnv, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (status, signal) => {
      if (done) return;
      done = true;
      resolve({ status: status ?? (signal ? 1 : 0), stdout, stderr, killed: Boolean(signal), pid: child.pid });
    };
    let killTimer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }, 500);
      }, timeoutMs);
    }
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => { if (killTimer) clearTimeout(killTimer); finish(1, null); });
    child.on("close", (status, signal) => { if (killTimer) clearTimeout(killTimer); finish(status, signal); });
    child.stdin.end(input ?? "");
  });
}

async function realHttp(url, { headers } = {}) {
  const response = await fetch(url, { headers });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { ok: response.ok, status: response.status, json };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const flags = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(CONFIG_URL, "utf8"));
  const gate = createGate({ transport: createGhTransport() });
  const lifecycle = createLifecycle({ gate, config });
  const batch = createBatch({ config, gate, lifecycle, run: realRun, http: realHttp, stateDir: flags["state-dir"] ?? DEFAULT_STATE_DIR });
  if (flags.help) {
    console.log("node tools/codex-batch.mjs [--dry-run] [--sole-dispatcher] [--resume] [--issues 13..44] [--setup-issue N] [--budget-usd 10] [--deadline-ms 28800000] [--state-dir DIR] [--json]");
    process.exitCode = 0;
  } else {
    const numbers = flags["setup-issue"] != null ? [Number(flags["setup-issue"])] : parseNumbers(flags.issues);
    const subsetInvalid = !flags["setup-issue"] && flags.issues && numbers.some((n) => n < PB_MIN || n > PB_MAX);
    const setupInvalid = flags["setup-issue"] != null && !Number.isInteger(numbers[0]);
    if (!numbers || subsetInvalid || setupInvalid) {
      console.error("usage error: --issues must be a subset of 13..44, or use --setup-issue N (a positive integer) for a rehearsal ticket");
      process.exitCode = 2;
    } else {
      const issues = await batch.scanIssues(numbers);
      if (flags["dry-run"]) {
        console.log(JSON.stringify(await batch.dryRun(issues), null, 2));
        process.exitCode = 0;
      } else {
        const own = resolveOwnExecutionId(process.env);
        const result = await batch.runBatch({
          numbers, budgetUsd: Number(flags["budget-usd"] ?? DEFAULT_BUDGET_USD),
          deadlineMs: Number(flags["deadline-ms"] ?? DEFAULT_BATCH_DEADLINE_MS), resume: Boolean(flags.resume),
          parentId: own.ok ? own.executionId : null, soleDispatcher: Boolean(flags["sole-dispatcher"]),
        });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
      }
    }
  }
}
