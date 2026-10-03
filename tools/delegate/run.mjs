#!/usr/bin/env node
// Delegation harness command line (docs/delegation/HARNESS_SPEC.md).
//
//   node tools/delegate/run.mjs start [--deadline-hours 8] [--usd 10]
//   node tools/delegate/run.mjs run                 loop until done, deadline, budget or STOP file
//   node tools/delegate/run.mjs ticket <n>          advance one ticket (must be Ready, or already in progress)
//   --no-merge (run, ticket)                       stop Automated tickets after verification; the owner merges
//   node tools/delegate/run.mjs status              one-page batch status
//   node tools/delegate/run.mjs stop                ask a running batch to stop after the current step
//   node tools/delegate/run.mjs check-sha <sha> [--ticket <n>]   the Verifier's one command
//   node tools/delegate/run.mjs reopens             record which finished tickets were reopened
//   node tools/delegate/run.mjs report              ledger statistics and tuning recommendations
//
// Batches start only on Matthew's instruction. The harness never deploys,
// applies migrations, chooses migration numbers, or merges Producer/External work.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateConfig } from "./core/config.mjs";
import { createState, delegateHome } from "./state.mjs";
import { realExec } from "./exec.mjs";
import { createPipeline, isTerminal } from "./pipeline.mjs";
import { buildReport, formatReport } from "./core/report.mjs";
import { readPrivateFile, secretFilePath } from "./core/secret-file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STOP_CODES = new Set(["SPEND_CAP", "BALANCE_UNRELIABLE", "USAGE_UNKNOWN", "WEEKLY_LIMIT", "RESET_UNKNOWN", "PLAN_RESET_AFTER_DEADLINE", "TRANSPORT", "HTTP_ERROR", "NO_BATCH"]);

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "tools/delegate/config.json"), "utf8"));
  const problems = validateConfig(config);
  if (problems.length) throw Object.assign(new Error(`invalid tools/delegate/config.json: ${problems.join("; ")}`), { code: "CONFIG" });
  return config;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i += 1; } else flags[key] = true;
    } else positional.push(rest[i]);
  }
  return { command, flags, positional };
}

function readKey(config, env, home) {
  const file = secretFilePath({ env, envName: config.deepseek.keyFileEnv, home, defaultName: config.deepseek.defaultKeyFile });
  return readPrivateFile(file, { label: "DeepSeek key file", code: "NO_KEY", hint: `set ${config.deepseek.keyFileEnv} or create ${path.join("$DELEGATE_HOME", config.deepseek.defaultKeyFile)}` });
}

// Passed to Codex sessions as GH_TOKEN, so lifecycle calls inside the sandbox are authenticated.
function readGithubToken(config, env, home) {
  const { githubTokenFileEnv: envName, githubTokenFile: defaultName } = config.codex;
  return readPrivateFile(secretFilePath({ env, envName, home, defaultName }), { label: "GitHub token file", code: "NO_GITHUB_TOKEN", hint: `set ${envName} or create ${path.join("$DELEGATE_HOME", defaultName)}, chmod 600` });
}

async function fullContext({ env, out, stopBeforeMerge = false }) {
  const config = loadConfig();
  const home = delegateHome(env);
  const state = createState(home);
  const { createGate } = await import("../../scripts/roadmap/gate.mjs");
  const { createGhTransport } = await import("../../scripts/roadmap/github-transport.mjs");
  const { createLifecycle } = await import("../../scripts/roadmap/lifecycle.mjs");
  const { createBatchPlanner } = await import("../codex-batch.mjs");
  const { createDeepSeek } = await import("./deepseek.mjs");
  const { runCodexSession } = await import("./codex-session.mjs");
  const roadmapConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/roadmap/config.json"), "utf8"));
  const gate = createGate({ transport: createGhTransport() });
  const lifecycle = createLifecycle({ gate, config: roadmapConfig, env });
  const planner = createBatchPlanner({ config: roadmapConfig, gate, lifecycle });
  const recordDir = path.join(home, "deepseek");
  const deepseek = createDeepSeek({
    baseUrl: config.deepseek.baseUrl,
    apiKey: readKey(config, env, home),
    timeoutMs: config.deepseek.timeoutMs,
    recorder: (entry) => {
      fs.mkdirSync(recordDir, { recursive: true });
      fs.writeFileSync(path.join(recordDir, `${entry.at.replace(/[:.]/g, "-")}-${String(entry.purpose).replace(/[^\w-]/g, "_")}.json`), JSON.stringify(entry, null, 2));
    },
  });
  const githubToken = readGithubToken(config, env, home);
  const runSession = (opts) => runCodexSession({ ...opts, command: config.codex.command, sandbox: config.codex.sandbox, extraConfig: config.codex.extraConfig, timeoutMs: config.codex.timeoutMs, env, githubToken });
  const pipeline = createPipeline({ config, repoRoot, state, exec: realExec, gate, lifecycle, deepseek, runSession, env, projectNumber: roadmapConfig.project?.number ?? null, stopBeforeMerge, log: (m) => out(`[${new Date().toISOString()}] ${m}`) });
  return { config, state, gate, lifecycle, planner, deepseek, pipeline };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export async function runCli(argv = process.argv.slice(2), { env = process.env, out = (s) => console.log(s), err = (s) => console.error(s), now = Date.now } = {}) {
  const { command, flags, positional } = parseArgs(argv);
  try {
    if (command === "check-sha") {
      // Runs inside the Verifier's sandboxed session: reads state, writes only under the OS temp dir.
      const config = loadConfig();
      const state = createState(delegateHome(env));
      const pipeline = createPipeline({ config, repoRoot, state, exec: realExec, env });
      const sha = positional[0];
      const res = pipeline.checkSha(String(sha ?? ""), { ticket: flags.ticket ? Number(flags.ticket) : null });
      out(res.summary);
      return res.ok ? 0 : 1;
    }

    if (command === "status") {
      const state = createState(delegateHome(env));
      const b = state.readBatch();
      out(b ? `batch started ${b.startedAt}; deadline ${new Date(b.deadlineMs).toISOString()}; DeepSeek baseline $${b.baselineUsd} cap $${b.capUsd}; Codex sessions ${b.sessionsRun ?? 0}; plan reading ${b.rateReading ? `${b.rateReading.primary.usedPercent}% (5h)` : "unknown"}; credits on overage ${(b.creditsSpent ?? 0).toFixed(1)}` : "no batch started");
      for (const n of state.listTickets()) {
        const t = state.readTicket(n);
        out(`#${n} ${t.phase}${t.lane ? ` (${t.lane})` : ""}${t.blocked ? ` - ${t.blocked.cause}` : ""}${t.prUrl ? ` - ${t.prUrl}` : ""}`);
      }
      if (state.stopRequested()) out("STOP file present: the batch stops after its current step.");
      return 0;
    }

    if (command === "report") {
      const state = createState(delegateHome(env));
      const tickets = state.listTickets().map((n) => state.readTicket(n)).filter(Boolean);
      const reopens = readJsonFile(path.join(state.home, "reopens.json"));
      const audits = readJsonFile(path.join(state.home, "audits.json"));
      out(formatReport(buildReport({ tickets, reopens, audits })));
      return 0;
    }

    if (command === "reopens") {
      const config = loadConfig();
      const state = createState(delegateHome(env));
      const { createGate } = await import("../../scripts/roadmap/gate.mjs");
      const { createGhTransport } = await import("../../scripts/roadmap/github-transport.mjs");
      const gate = createGate({ transport: createGhTransport() });
      const file = path.join(state.home, "reopens.json");
      const record = readJsonFile(file);
      const windowMs = Number(flags.days ?? 14) * 86_400_000;
      let checked = 0;
      for (const n of state.listTickets()) {
        const t = state.readTicket(n);
        if (t?.phase !== "finished" || !t.finishedAt || now() - Date.parse(t.finishedAt) > windowMs) continue;
        const res = await gate.read({ query: "query DelegateReopen($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) { state } } }", variables: { o: config.repository.owner, r: config.repository.name, n } });
        if (!res.ok) throw Object.assign(new Error(`issue #${n}: ${res.message}`), { code: res.code });
        const reopened = res.data.repository.issue.state === "OPEN";
        record[n] = { reopened: reopened || record[n]?.reopened === true, checkedAt: new Date(now()).toISOString() };
        checked += 1;
        if (reopened) out(`#${n} was reopened after the harness finished it`);
      }
      fs.mkdirSync(state.home, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      out(`checked ${checked} finished ticket(s) from the last ${flags.days ?? 14} days`);
      return 0;
    }

    if (command === "stop") {
      const state = createState(delegateHome(env));
      fs.mkdirSync(state.home, { recursive: true });
      fs.writeFileSync(state.stopFile, `stop requested ${new Date(now()).toISOString()}\n`);
      out("stop requested; the running batch stops after its current step");
      return 0;
    }

    if (command === "start") {
      const ctx = await fullContext({ env, out });
      const existing = ctx.state.readBatch();
      if (existing && pidAlive(existing.runnerPid) && existing.runnerPid !== process.pid) throw Object.assign(new Error(`a batch runner (pid ${existing.runnerPid}) is live`), { code: "BATCH_LIVE" });
      const models = await ctx.deepseek.listModels();
      if (!models.ok) throw Object.assign(new Error(models.message), { code: models.code });
      const needed = [...new Set([...ctx.config.ladder.map((r) => r.model), ctx.config.deepseek.scout.model, ctx.config.deepseek.testAuthor.model])];
      const missing = needed.filter((m) => !models.ids.includes(m));
      if (missing.length) throw Object.assign(new Error(`DeepSeek /models lacks ${missing.join(", ")}`), { code: "MODELS_MISSING" });
      const balance = await ctx.deepseek.balance();
      if (!balance.ok) throw Object.assign(new Error("DeepSeek balance unreadable; not starting"), { code: "BALANCE_UNRELIABLE" });
      const hours = Number(flags["deadline-hours"] ?? ctx.config.batch.deadlineHours);
      const usd = Number(flags.usd ?? ctx.config.deepseek.usdPerBatch);
      fs.rmSync(ctx.state.stopFile, { force: true });
      ctx.state.writeBatch({ startedAt: new Date(now()).toISOString(), deadlineMs: now() + hours * 3_600_000, baselineUsd: balance.usd, capUsd: usd, sessionsRun: 0, creditsSpent: 0, rateReading: null, runnerPid: null });
      out(`batch started: deadline ${hours}h, DeepSeek baseline $${balance.usd.toFixed(2)}, cap $${usd}; models ok (${needed.join(", ")})`);
      return 0;
    }

    if (command === "run" || command === "ticket") {
      const ctx = await fullContext({ env, out, stopBeforeMerge: flags["no-merge"] === true });
      const b = ctx.state.readBatch();
      if (!b) throw Object.assign(new Error("no batch started; run `start` first"), { code: "NO_BATCH" });
      if (b.runnerPid && b.runnerPid !== process.pid && pidAlive(b.runnerPid)) throw Object.assign(new Error(`another runner (pid ${b.runnerPid}) is live`), { code: "BATCH_LIVE" });
      ctx.state.writeBatch({ ...b, runnerPid: process.pid });
      try {
        if (command === "ticket") {
          const n = Number(positional[0]);
          if (!Number.isInteger(n)) throw Object.assign(new Error("ticket needs an issue number"), { code: "USAGE" });
          return await advanceOne(ctx, n, out);
        }
        return await loop(ctx, out, now);
      } finally {
        ctx.state.writeBatch({ ...ctx.state.readBatch(), runnerPid: null });
      }
    }

    out(helpText());
    return command === "help" || command === undefined ? 0 : 2;
  } catch (error) {
    err(`STOPPED ${error.code ?? "ERROR"}: ${error.message}`);
    return 1;
  }
}

async function advanceOne(ctx, n, out) {
  let t = ctx.state.readTicket(n);
  if (!t || isTerminal(t.phase)) {
    const plan = await ctx.planner.plan();
    if (plan.selected?.number !== n) {
      out(`#${n} is not the planner's selected Ready ticket (selected: ${plan.selected?.number ?? "none"}); not starting it`);
      return 1;
    }
    t = await ctx.pipeline.intake(n, plan.selected);
  }
  t = await ctx.pipeline.advance(t);
  out(`#${n} ${t.phase}${t.blocked ? `: ${t.blocked.cause}` : ""}`);
  return 0;
}

export async function loop(ctx, out, now) {
  const seen = new Set();
  const batchSize = ctx.config.batch.triageBatchSize;
  for (;;) {
    const b = ctx.state.readBatch();
    if (ctx.state.stopRequested()) { out("stop file found; batch stopped"); return 0; }
    if (now() > b.deadlineMs) { out("deadline reached; batch stopped"); return 0; }
    const pending = ctx.state.listTickets().map((n) => ctx.state.readTicket(n)).filter((t) => t && !isTerminal(t.phase))
      .sort((a, b2) => (a.queuedAt ?? 0) - (b2.queuedAt ?? 0) || a.n - b2.n);
    let current = pending[0] ?? null;
    try {
      if (pending.length === 0) {
        // Take the next eligible Ready tickets (several when triage is batched) through intake and recon.
        const plan = await ctx.planner.plan();
        const queue = (plan.readyQueue ?? (plan.selected ? [plan.selected] : [])).filter((q) => !seen.has(q.number)).slice(0, batchSize);
        if (queue.length === 0) {
          const again = plan.selected && seen.has(plan.selected.number);
          out(again
            ? `#${plan.selected.number} is still selected after the harness finished with it (phase ${ctx.state.readTicket(plan.selected.number)?.phase}); stopping to avoid a loop`
            : `no eligible Ready work${plan.promotionCandidates.length ? `; ${plan.promotionCandidates.length} promotion candidate(s) need Matthew` : ""}`);
          return again ? 1 : 0;
        }
        for (const q of queue) {
          seen.add(q.number);
          current = await ctx.pipeline.intake(q.number, q);
          if (!isTerminal(current.phase)) {
            current.queuedAt = now();
            ctx.state.writeTicket(current.n, current);
            if (current.phase === "worktree") current = await ctx.pipeline.recon(current);
          }
          if (isTerminal(current.phase)) out(`#${current.n} ${current.phase}${current.blocked ? `: ${current.blocked.cause}` : ""}`);
        }
        continue;
      }
      const awaitingTriage = pending.filter((t) => t.phase === "recon");
      if (batchSize > 1 && awaitingTriage.length >= 2) {
        const triaged = await ctx.pipeline.batchTriage(awaitingTriage.slice(0, batchSize));
        out(`batch triage: ${triaged.map((t) => `#${t.n} ${t.phase}`).join(", ")}`);
        continue;
      }
      current = await ctx.pipeline.advance(current);
      out(`#${current.n} ${current.phase}${current.blocked ? `: ${current.blocked.cause}` : ""}${current.prUrl ? ` (${current.prUrl})` : ""}`);
    } catch (error) {
      if (STOP_CODES.has(error.code)) { out(`batch stopped: ${error.code} ${error.message}`); return 1; }
      out(`unexpected error${current ? ` on #${current.n}` : ""}; batch stopped for safety: ${error.code ?? ""} ${error.message}`);
      return 1;
    }
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function helpText() {
  return `Delegation harness (docs/delegation/HARNESS_SPEC.md)

  node tools/delegate/run.mjs start [--deadline-hours 8] [--usd 10]
  node tools/delegate/run.mjs run [--no-merge]
  node tools/delegate/run.mjs ticket <n> [--no-merge]   (--no-merge: stop after verification; you merge and complete)
  node tools/delegate/run.mjs status
  node tools/delegate/run.mjs stop
  node tools/delegate/run.mjs check-sha <full-sha> [--ticket <n>]
  node tools/delegate/run.mjs reopens [--days 14]
  node tools/delegate/run.mjs report

Private state: $DELEGATE_HOME (default ~/.local/share/brainstorm-delegate).
DeepSeek key: the file named by $DEEPSEEK_KEY_FILE, or $DELEGATE_HOME/deepseek.key (chmod 600).
Exit codes: 0 done, 1 stopped or refused (reason printed), 2 bad usage.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => { process.exitCode = code; });
}
