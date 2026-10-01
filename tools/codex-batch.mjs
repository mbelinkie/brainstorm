// DeepSeek batch dispatcher (issue #51): a small, on-request, sequential runner.
//
// It is the one dispatcher for the host. It reuses scripts/roadmap/gate.mjs for
// every repo-owned GitHub read/write (project scan, PR creation, merge). Git,
// npm and codex are spawned here (tools/ is outside scripts/, which the bypass
// check forbids from importing child_process). Private run state and logs live
// outside git, in owner-only files.
//
//   node tools/codex-batch.mjs --dry-run            plan only; no writes, no model API
//   node tools/codex-batch.mjs [--resume] [--issues 13..44] [--budget-usd 10]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createGate } from "../scripts/roadmap/gate.mjs";
import { createGhTransport } from "../scripts/roadmap/github-transport.mjs";
import { createLifecycle } from "../scripts/roadmap/lifecycle.mjs";
import { parseClaims } from "../scripts/roadmap/lifecycle-core.mjs";
import {
  DEFAULT_ATTEMPTS, DEFAULT_BATCH_DEADLINE_MS, DEFAULT_BUDGET_USD, attemptsRemaining, branchName,
  budgetAllowsNext, decideAcceptance, headMatchesReviewed, isPastDeadline, parseDeepseekBalance,
  renderPrBody, renderSolPrompt, renderWorkerPrompt, resumeDecision, routeIssue, selectEligibleIssues,
  sessionSpendUsd, validateBalance, worktreeName,
} from "./batch-core.mjs";

const CONFIG_URL = new URL("../docs/roadmap/config.json", import.meta.url);
const DEEPSEEK_KEY_PATH = path.join(os.homedir(), ".codex", "deepseek-api-key");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "share", "brainstorm-batch");
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const ITEM = `project { number owner { ... on User { login } ... on Organization { login } } }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  acceptance: fieldValueByName(name: "Acceptance") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;

const ISSUE = `number state title body
  labels(first: 30) { nodes { name } }
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
  if (!value) return Array.from({ length: 44 - 13 + 1 }, (_, i) => 13 + i);
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
  stateDir = DEFAULT_STATE_DIR, keyPath = DEEPSEEK_KEY_PATH,
} = {}) {
  const owner = config.repository.owner;
  const name = config.repository.name;
  const repo = `${owner}/${name}`;

  const stateFile = () => path.join(stateDir, "run-state.json");
  const logFile = () => path.join(stateDir, "batch.log");

  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return { startedAt: null, issues: {} }; }
  }

  function saveState(state) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  function log(entry) {
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(logFile(), `${new Date(now()).toISOString()} ${JSON.stringify(entry)}\n`);
    } catch { /* logging must never break the run */ }
  }

  // The key is read into the worker process environment only; it is never part
  // of a prompt, comment, PR, commit, or public log.
  const loadKey = () => {
    try { return fs.readFileSync(keyPath, "utf8").trim() || null; } catch { return null; }
  };

  async function balance(key) {
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
    return numbers.map((n) => normalizeIssue(config, result.data?.repository?.[`i${n}`], n)).filter((i) => i.title !== undefined);
  }

  function select(issues, { externalAuthorized } = {}) {
    const numbers = issues.map((i) => i.number);
    return selectEligibleIssues(issues, {
      minNumber: Math.min(...numbers), maxNumber: Math.max(...numbers), externalAuthorized: externalAuthorized ?? new Set(),
    });
  }

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
    return { ok: true, number: result.data?.number, url: result.data?.html_url };
  }

  async function mergePullRequest(prNumber) {
    return gate.rest({ method: "PUT", path: `/repos/${repo}/pulls/${prNumber}/merge`, body: { merge_method: "merge" } });
  }

  // ---- one ticket ---------------------------------------------------------

  async function runTicket(ticket, state, { externalAuthorized } = {}) {
    const number = ticket.number;
    const existing = state.issues[number];

    // Reconcile before any action: never duplicate a claim, PR or completion.
    const decision = resumeDecision({
      persisted: existing,
      live: { status: ticket.status, liveClaimExecutionId: ticket.liveClaim, completeRecorded: false, prNumber: existing?.prNumber ?? null },
    });
    if (decision.action === "skip-completed" || decision.action === "skip-held") {
      log({ op: "skip", issue: number, action: decision.action });
      return { skipped: true, action: decision.action };
    }
    if (existing && attemptsRemaining(state, number, DEFAULT_ATTEMPTS) === 0) {
      log({ op: "stop", issue: number, reason: "attempt limit reached" });
      return { blocked: true, code: "ATTEMPTS_EXHAUSTED" };
    }

    const routing = routeIssue(ticket.labels, config.routing);
    if (routing.problems.length > 0) {
      log({ op: "block", issue: number, problems: routing.problems });
      return { blocked: true, code: "ROUTING", problems: routing.problems };
    }
    if (ticket.acceptance === "External" && !externalAuthorized?.has(number)) {
      return { skipped: true, acceptance: "External" };
    }
    if (!["Ready", "Backlog"].includes(ticket.status)) {
      log({ op: "skip", issue: number, status: ticket.status });
      return { skipped: true, status: ticket.status };
    }

    if (ticket.status === "Backlog") {
      const promoted = await lifecycle.ready(number);
      if (!promoted.ok) {
        const blocked = await lifecycle.block(number, {
          cause: "Ready gates failed", needs: "owner to fix the contract or routing", executionId: env.CODEX_THREAD_ID,
        });
        log({ op: "block", issue: number, code: promoted.code, blocked: blocked.ok });
        return { blocked: true, code: promoted.code };
      }
    }

    const key = loadKey();
    if (!key) return { stopped: true, reason: "no DeepSeek API key" };
    const before = await balance(key);
    if (!before.ok) return { stopped: true, reason: before.reason };

    const repoInfo = await discoverRepo();
    const top = repoInfo.top;
    const runNumber = (existing?.attempts ?? 0) + 1;
    const branch = branchName(number, runNumber);
    const worktree = worktreeName(number, runNumber);
    const treePath = path.resolve(top, "..", `quiz-pb-${number}-${runNumber}`);

    await git(["fetch", "origin", "main"], { cwd: top });
    await git(["worktree", "add", treePath, "-b", branch, "origin/main"], { cwd: top });
    await git(["status", "--short", "--branch"], { cwd: treePath });
    const install = await run("npm", ["ci"], { cwd: treePath });
    if (install.status !== 0) return { blocked: true, code: "INSTALL_FAILED" };

    const workerPrompt = renderWorkerPrompt({
      number, title: ticket.title, body: ticket.body, branch, worktree, startCommit: "origin/main",
      modelId: routing.modelId, effectiveEffort: routing.effectiveEffort,
    });
    const worker = await run("codex", ["exec", "-p", "deepseek", "--model", routing.modelId, "-c", "approval_policy=never", "--add-dir", repoInfo.shared, "--json"], {
      cwd: treePath, input: workerPrompt, env: { DEEPSEEK_API_KEY: key },
    });
    log({ op: "worker", issue: number, status: worker.status, stdoutTail: String(worker.stdout ?? "").slice(-400) });

    const after = await balance(key);
    const spend = sessionSpendUsd(before, after);
    if (!after.ok) return { stopped: true, reason: after.reason };
    if (!spend || spend.increase) return { stopped: true, reason: "balance increased unexpectedly; stopping" };

    const inspection = await lifecycle.inspect(number);
    const reviewed = (inspection?.comments ?? []).filter((c) => (c.body ?? "").startsWith("<!-- review:v1")).at(-1);
    const reviewedSha = /- Tested commit:\s*`([0-9a-f]{7,40})`/i.exec(reviewed?.body ?? "")?.[1] ?? null;

    const pr = await findPullRequest(branch);
    if (!pr.pr) {
      const opened = await openPullRequest(branch, `Implement #${number}`, renderPrBody({ number, title: ticket.title, commit: reviewedSha ?? "unknown", branch }));
      if (!opened.ok) return { blocked: true, code: opened.code, message: opened.message };
    }

    const cls = decideAcceptance({ acceptance: ticket.acceptance, independentVerify: false, ownerAcceptance: false });
    if (cls === "skip") return { skipped: true, acceptance: ticket.acceptance };

    const solPrompt = renderSolPrompt({ number, reviewedSha: reviewedSha ?? "unknown", branch });
    const sol = await run("codex", ["exec", "--model", "gpt-6.1-sol", "--json"], { cwd: treePath, input: solPrompt });
    log({ op: "sol", issue: number, status: sol.status });

    if (ticket.acceptance === "Automated") {
      const head = pr.pr?.head?.sha ?? null;
      if (!reviewedSha || !headMatchesReviewed(head, reviewedSha)) {
        return { blocked: true, code: "HEAD_MISMATCH" };
      }
      const merged = await mergePullRequest(pr.pr.number);
      if (!merged.ok) return { blocked: true, code: merged.code, message: merged.message };
      await run("npm", ["ci"], { cwd: top });
      const test = await run("npm", ["test"], { cwd: top });
      if (test.status !== 0) return { blocked: true, code: "TEST_FAILED" };
      const completed = await lifecycle.complete(number);
      state.issues[number] = { ...existing, phase: "done", reviewedSha, prNumber: pr.pr.number, completed: completed.ok, attempts: runNumber };
      return { completed: completed.ok, code: completed.ok ? null : completed.code, spendUsd: spend.spend };
    }

    // Producer: publish + independent review, then wait for human acceptance.
    state.issues[number] = { ...existing, phase: "reviewed", reviewedSha, prNumber: pr.pr?.number ?? null, attempts: runNumber };
    return { reviewed: true, waiting: ticket.acceptance, spendUsd: spend.spend };
  }

  async function runBatch({ numbers, externalAuthorized, budgetUsd = DEFAULT_BUDGET_USD, deadlineMs = DEFAULT_BATCH_DEADLINE_MS, resume = false } = {}) {
    const state = loadState();
    if (resume && !state.startedAt) return { ok: false, code: "NO_STATE", message: "no persisted run state to resume" };
    const startMs = resume && state.startedAt ? Date.parse(state.startedAt) : now();
    state.startedAt = new Date(startMs).toISOString();
    saveState(state);

    const issues = await scanIssues(numbers);
    const eligible = select(issues, { externalAuthorized });
    const results = [];
    let spentUsd = 0;
    for (let i = 0; i < eligible.length; i += 1) {
      const ticket = eligible[i];
      if (isPastDeadline({ startMs, deadlineMs, nowMs: now() })) {
        results.push({ number: ticket.number, stopped: true, reason: "batch deadline reached" });
        break;
      }
      if (!budgetAllowsNext({ spentUsd, budgetUsd, isLastTicket: i === eligible.length - 1 })) {
        results.push({ number: ticket.number, stopped: true, reason: "budget exhausted" });
        break;
      }
      const result = await runTicket(ticket, state, { externalAuthorized });
      spentUsd += result.spendUsd ?? 0;
      results.push({ number: ticket.number, ...result });
      saveState(state);
    }
    return { ok: true, op: "batch", results };
  }

  async function dryRun(issues) {
    const eligible = select(issues);
    return { ok: true, op: "dry-run", selected: eligible.map((i) => ({ number: i.number, title: i.title, status: i.status, priority: i.priority, acceptance: i.acceptance })) };
  }

  return { discoverRepo, scanIssues, select, dryRun, runBatch, runTicket, loadKey, balance };
}

// ---- command line ---------------------------------------------------------

const BOOL = new Set(["dry-run", "resume", "help", "json"]);

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

function realRun(command, args, { cwd, input, env: extraEnv } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => resolve({ status: 0, stdout, stderr: String(error), killed: false }));
    child.on("close", (status, signal) => resolve({ status: status ?? (signal ? 1 : 0), stdout, stderr, killed: Boolean(signal) }));
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
  const batch = createBatch({ config, gate, lifecycle, run: realRun, http: realHttp });
  if (flags.help) {
    console.log("node tools/codex-batch.mjs [--dry-run] [--resume] [--issues 13..44] [--budget-usd 10] [--deadline-ms 28800000] [--json]");
    process.exitCode = 0;
  } else {
    const numbers = parseNumbers(flags.issues);
    if (!numbers) {
      console.error("usage error: --issues must be numbers or a range like 13..44");
      process.exitCode = 2;
    } else {
      const issues = await batch.scanIssues(numbers);
      if (flags["dry-run"]) {
        console.log(JSON.stringify(await batch.dryRun(issues), null, 2));
        process.exitCode = 0;
      } else {
        const result = await batch.runBatch({
          numbers, budgetUsd: Number(flags["budget-usd"] ?? DEFAULT_BUDGET_USD),
          deadlineMs: Number(flags["deadline-ms"] ?? DEFAULT_BATCH_DEADLINE_MS), resume: Boolean(flags.resume),
        });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok ? 0 : 1;
      }
    }
  }
}
