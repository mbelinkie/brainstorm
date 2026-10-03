// The ticket pipeline (DELEGATION.md section 5): every step the harness takes
// for one ticket, from intake to finish. Each step reads and writes the
// ticket's private state, re-checks live state where it matters, and is safe
// to re-run after a crash.
//
// GitHub is reached only through the roadmap gate and lifecycle; git, npm and
// node through the injected exec; DeepSeek through the injected client; Codex
// through the injected session runner.
//
// Phases:
//   intake -> worktree -> recon -> [triaged | needs-sol] -> claimed
//   per slice: claimed -> tests -> implemented -> checked -> (gate) -> next slice or done
//   protected: rpc (Sol's real-process check) -> accepted
//   accepted -> pushed -> published -> reviewed -> verified -> finished | awaiting-owner
// Terminal: flagged, blocked, awaiting-owner, finished.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAny } from "./core/paths.mjs";
import { parseNumstat, parseAddedLines, parseUntracked, summarizeChanges } from "./core/diff.mjs";
import { parseJunit, acceptanceStatus, failsForTheRightReason, acceptancePassed } from "./core/junit.mjs";
import { checkResponse, stageArtifact } from "./core/artifacts.mjs";
import { staticGuards, testGuards, regressionOnlyGuards, classify, formatGuardLines } from "./core/guards.mjs";
import { makeLock, lockMismatches } from "./core/accept-lock.mjs";
import { runLadder, failureExcerpt } from "./core/ladder.mjs";
import { renderBundle } from "./core/bundle.mjs";
import { selectContext, verifyClaims, validateRecon, validateTriage, normalizeSlices } from "./core/recon.mjs";
import { renderWorkerPacket, renderTestAuthorPacket, renderScoutPacket, renderSessionInput, renderMutantPacket, renderPreReviewPacket } from "./core/packet.mjs";
import { overBudget, creditsFor, parseRateLimits, headroom } from "./core/codex.mjs";
import { shouldAudit, applyCategoryOverrides, ladderStartFor } from "./core/report.mjs";
import { buildMessages, chatWithLengthRetry, createSpendGuard, estimateUsd } from "./deepseek.mjs";
import { appendLedger, readJson, writeJsonAtomic } from "./state.mjs";
import { shellQuote } from "./exec.mjs";

const TERMINAL = new Set(["flagged", "blocked", "awaiting-owner", "finished"]);
export const isTerminal = (phase) => TERMINAL.has(phase);

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
const stop = (code, message) => Object.assign(new Error(message), { code });

// n is the ticket's own number: a one-ticket reply spells it out, since a bare <n> was
// answered as 1 in the pilot. A batched reply covers several tickets, so it keeps <n>.
// Validation refuses a case listed in two slices; state the rule so the models follow it.
const ONE_SLICE_RULE = "Every acceptance case belongs to exactly one slice. If a case covers work in two slices, split it into one case per slice.";

const triageReply = (n = "<n>") => `{"n":${n},"fit":"ok|flag","lane":"express|standard|protected","decisions":["..."],"escalate":null|"reason","cases":[{"id":"A1","kind":"normal|failure|invariant","given":"...","expect":"..."}],"scope":["globs"],"allow":[],"slices":null|[{"id":"S1","goal":"...","scope":["globs"],"cases":["A1"]}]`;

export function createPipeline(ctx) {
  const { config, repoRoot, state, exec, gate, lifecycle, deepseek, runSession, now = Date.now, log = () => {}, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), projectNumber = null, stopBeforeMerge = false } = ctx;
  const repo = config.repository;
  const promptDir = ctx.promptDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
  const prompt = (name) => fs.readFileSync(path.join(promptDir, name), "utf8");
  const overrides = config.categoryOverrides ?? {};

  // ---- helpers -------------------------------------------------------------

  const git = (cwd, args, opts = {}) => exec("git", args, { cwd, ...opts });
  const must = (res, what) => {
    if (res.status !== 0) throw stop("EXEC_FAILED", `${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 400)}`);
    return res.stdout;
  };
  const readIn = (cwd) => (p) => {
    try { return fs.readFileSync(path.join(cwd, p), "utf8"); } catch { return null; }
  };
  const save = (t) => { state.writeTicket(t.n, t); return t; };
  const ticketPath = (t, name) => path.join(state.ticketDir(t.n), name);
  const writePrivate = (t, name, content) => {
    fs.mkdirSync(state.ticketDir(t.n), { recursive: true });
    fs.writeFileSync(ticketPath(t, name), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  const currentSlice = (t) => t.slices?.[t.sliceIndex ?? 0] ?? { id: "S1", goal: t.title };
  const casesFor = (t, slice) => (t.cases ?? []).filter((c) => (slice.caseIds ?? []).includes(c.id));

  async function block(t, cause, needs, phase = "blocked") {
    const res = await lifecycle.block(t.n, { cause: String(cause).slice(0, 500), needs });
    t.blocked = { cause: String(cause).slice(0, 500), needs, recorded: Boolean(res.ok), code: res.ok ? null : res.code };
    t.phase = phase;
    save(t);
    log(`#${t.n} ${phase}: ${cause}`);
    return t;
  }

  function batch() {
    const b = state.readBatch();
    if (!b) throw stop("NO_BATCH", "no batch started; run `start` first");
    return b;
  }

  // ---- DeepSeek ----------------------------------------------------------------

  const spendGuard = () => {
    const b = batch();
    return createSpendGuard({ baselineUsd: b.baselineUsd, capUsd: b.capUsd, readBalance: () => deepseek.balance() });
  };

  async function askDeepSeek(t, { model, effort, prefixFile, packet, failure = "", purpose }) {
    const messages = buildMessages({ prefix: prompt(prefixFile), conventions: conventionsBlock(), packet, failure });
    const res = await chatWithLengthRetry(deepseek, { model, effort, messages, maxTokens: config.deepseek.maxTokens, purpose: `t${t.n}-${purpose}`, jsonMode: config.deepseek.jsonMode }, { retryMaxTokens: config.deepseek.lengthRetryMaxTokens });
    for (const facts of res.attempts ?? []) addDeepSeekCost(t, facts);
    if (!res.ok) return res;
    const checked = checkResponse(res.body, { expectedModel: model });
    if (!checked.ok) return { ...checked, facts: res.facts };
    return { ok: true, artifact: checked.artifact, facts: res.facts };
  }

  // A one-off DeepSeek request (not part of the ladder) still respects the spend stop.
  async function askChecked(t, args) {
    const spend = await spendGuard()();
    if (!spend.ok) throw stop(spend.code, spend.message);
    const res = await askDeepSeek(t, args);
    if (!res.ok && (res.code === "TRANSPORT" || res.code === "HTTP_ERROR")) {
      const again = await askDeepSeek(t, { ...args, purpose: `${args.purpose}-retry` });
      if (!again.ok && (again.code === "TRANSPORT" || again.code === "HTTP_ERROR")) throw stop(again.code, again.message ?? "DeepSeek unavailable");
      return again;
    }
    return res;
  }

  function addDeepSeekCost(t, facts) {
    const usd = estimateUsd(facts.requestedModel, facts.usage, new Date(now()));
    t.deepseek ??= { usdEstimate: 0, requests: [] };
    t.deepseek.usdEstimate += usd ?? 0;
    t.deepseek.requests.push({ requestId: facts.requestId, model: facts.returnedModel, requested: facts.requestedModel, fingerprint: facts.fingerprint, effort: facts.effort, finish: facts.finishReason, usage: facts.usage, maxTokens: facts.maxTokens });
  }

  let conventionsCache = null;
  function conventionsBlock() {
    if (conventionsCache !== null) return conventionsCache;
    const claude = readIn(repoRoot)("CLAUDE.md") ?? "";
    const pick = (title) => {
      const m = new RegExp(`## ${title}[\\s\\S]*?(?=\\n## )`).exec(claude);
      return m ? m[0].trim() : "";
    };
    conventionsCache = [pick("Product invariants that must not regress"), pick("Repository shape")].filter(Boolean).join("\n\n");
    return conventionsCache;
  }

  // ---- Codex sessions ------------------------------------------------------------

  // Plan limits pause the batch (wait for the reset) or stop it; they never block a ticket.
  async function waitForHeadroom() {
    for (;;) {
      const b = batch();
      const room = headroom({ reading: b.rateReading ?? null, headroomPercent: config.plan.headroomPercent, creditCap: config.plan.creditCap, creditsSpent: b.creditsSpent ?? 0, firstSession: (b.sessionsRun ?? 0) === 0, requireReading: config.plan.requireUsageReading !== false, nowMs: now() });
      if (room.action === "start") return room;
      if (room.action === "stop") throw stop(room.code, `batch stopped: ${room.reason}`);
      if (room.untilMs > b.deadlineMs) throw stop("PLAN_RESET_AFTER_DEADLINE", `batch stopped: plan resets after the deadline (${room.reason})`);
      log(`plan limit: ${room.reason}; sleeping until ${new Date(room.untilMs).toISOString()}`);
      await sleep(Math.max(0, room.untilMs - now()) + 60_000);
      // The reading is stale after a reset; the next session refreshes it.
      state.writeBatch({ ...state.readBatch(), rateReading: null, sessionsRun: 0 });
    }
  }

  // Working-tree contents (tracked diff plus untracked files) and HEAD.
  function treeFingerprint(dir) {
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const diff = git(dir, ["diff", "HEAD"]).stdout;
    const untracked = parseUntracked(git(dir, ["status", "--porcelain=v1", "-uall"]).stdout);
    const read = readIn(dir);
    return JSON.stringify([head, diff, untracked.map((p) => [p, read(p)])]);
  }

  // owners: tickets the session is charged to (a batched triage is shared).
  async function session(owners, roleName, { step, body, commands = [], reply, resumeId = null, cwd, exempt = false, dirOwner }) {
    const list = Array.isArray(owners) ? owners : [owners];
    const t = dirOwner ?? list[0];
    const role = config.codex.roles[roleName];
    if (!exempt && !resumeId) {
      for (const o of list) {
        const perTicket = config.budgets.sessionsPerTicket[o.lane ?? "standard"] ?? 4;
        const threads = new Set((o.codexSessions ?? []).filter((x) => !x.exempt).map((x) => x.threadId).filter(Boolean));
        if (threads.size >= perTicket) return fail("SESSION_BUDGET", `#${o.n} already used ${threads.size} Codex sessions (limit ${perTicket} for ${o.lane ?? "standard"})`);
      }
    }
    const room = await waitForHeadroom();
    const b = batch();
    const used = (t.codexSessions ?? []).length;
    // Absolute path from the harness checkout: a ticket worktree starts from main
    // and may not have the current cards.
    const input = renderSessionInput({ card: path.resolve(repoRoot, role.card), step, body, commands, reply });
    const dir = path.join(state.ticketDir(t.n), "codex", `${String(used + 1).padStart(2, "0")}-${roleName}-${step.replace(/\W+/g, "-")}`);
    const workdir = cwd ?? t.worktree ?? repoRoot;
    const guarded = list.filter((o) => o.worktree && fs.existsSync(o.worktree));
    const before = guarded.map((o) => treeFingerprint(o.worktree));
    const res = await runSession({ role, cwd: workdir, prompt: input, sessionDir: dir, resumeId });
    const changed = guarded.filter((o, i) => treeFingerprint(o.worktree) !== before[i]);
    const credits = creditsFor(role.model, res.usage);
    for (const o of list) {
      o.codexSessions = [...(o.codexSessions ?? []), { role: roleName, step, threadId: res.threadId, model: role.model, effort: role.effort, usage: res.usage, credits: credits === null ? null : credits / list.length, shared: list.length > 1 ? list.length : undefined, exempt: exempt || undefined, onCredits: Boolean(room.onCredits), ok: res.ok }];
      save(o);
    }
    // A session Codex refused before any turn completed (rejected model, sign-in) used no
    // plan, so it leaves the batch's count and reading as they were.
    const refused = !res.ok && !res.usage && !res.turns && res.errors.length > 0;
    if (!refused) {
      // An unreadable reading is stored as null on purpose: the next session then
      // stops the batch (unknown usage counts as exhausted) instead of trusting a stale one.
      const reading = readRateLimits(res.threadId);
      state.writeBatch({ ...state.readBatch(), sessionsRun: (b.sessionsRun ?? 0) + 1, rateReading: reading, creditsSpent: (b.creditsSpent ?? 0) + (room.onCredits ? credits ?? 0 : 0) });
      if (!reading) log("warning: plan usage could not be read from this Codex session's log; the next session will stop the batch");
    }
    if (changed.length) return fail("WORKTREE_CHANGED", `${roleName} session changed files in ${changed.map((o) => `#${o.n}`).join(", ")}; role sessions never edit files`, { session: res });
    // A session that never got a usable reply (rejected model, sign-in, network) reports its own error, not "usage missing".
    if (!res.ok && !res.usage && res.errors.length) return fail("SESSION_FAILED", `${roleName} session failed (${role.model}): ${res.errors[res.errors.length - 1]}`, { session: res });
    const budget = overBudget(res.usage, config.budgets[roleName]);
    if (budget.over) return fail("CODEX_BUDGET", `${roleName} session over budget: ${budget.reason}`, { session: res });
    if (!res.ok) return fail("SESSION_FAILED", `${roleName} session failed: ${res.decisionError ?? (res.errors.join("; ") || `exit ${res.exitCode}`)}`, { session: res });
    return { ok: true, decision: res.decision, threadId: res.threadId, session: res };
  }

  function readRateLimits(threadId) {
    if (!threadId) return null;
    const home = env.CODEX_HOME || path.join(env.HOME ?? "", ".codex");
    const file = findFile(path.join(home, "sessions"), (name) => name.includes(threadId) && name.endsWith(".jsonl"), 5);
    return file ? parseRateLimits(fs.readFileSync(file, "utf8")) : null;
  }

  // ---- intake and recon -------------------------------------------------------------

  async function intake(n, selected) {
    const existing = state.readTicket(n);
    if (existing && !isTerminal(existing.phase)) return existing;
    // A retry after a terminal attempt gets fresh names; earlier worktrees and branches are never reused or deleted.
    const attempt = existing ? (existing.attempt ?? 1) + 1 : 1;
    const inspected = await lifecycle.inspect(n);
    if (!inspected.ok) throw stop(inspected.code, `inspect #${n}: ${inspected.message}`);
    const issue = await gate.read({
      query: `query DelegateIssue($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) { title body
        projectItems(first: 10) { nodes { project { number } workstream: fieldValueByName(name: "Workstream") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`,
      variables: { o: repo.owner, r: repo.name, n },
    });
    if (!issue.ok) throw stop(issue.code, `issue read #${n}: ${issue.message}`);
    const node = issue.data.repository.issue;
    const item = (node.projectItems?.nodes ?? []).find((i) => projectNumber === null || i.project?.number === projectNumber);
    const t = {
      n,
      title: node.title,
      body: node.body,
      labels: inspected.labels ?? [],
      category: item?.workstream?.name ?? "uncategorized",
      acceptanceClass: inspected.acceptanceClass ?? selected?.acceptance ?? null,
      baseSha: selected?.baseline ?? inspected.baseline?.oid,
      phase: "intake",
      attempt,
      previous: existing ? { phase: existing.phase, branch: existing.branch ?? null, blocked: existing.blocked ?? null } : undefined,
      startedAt: new Date(now()).toISOString(),
    };
    save(t);
    const flagged = t.labels.filter((l) => config.fitGate.flagLabels.includes(l));
    if (flagged.length) {
      return block(t, `Gate 0: labelled ${flagged.join(", ")}; not suited to delegated coding`, "Matthew: skip (interactive Claude session), run anyway (remove the label), or split into testable coding tickets", "flagged");
    }
    const suffix = attempt > 1 ? `-${attempt}` : "";
    const name = `${config.worktreePrefix}${n}${suffix}`;
    t.branch = `${config.branchPrefix}${n}${suffix}`;
    t.worktreeName = `${config.worktreeParent}/${name}`;
    t.worktree = path.resolve(repoRoot, config.worktreeParent, name);
    if (!fs.existsSync(t.worktree)) {
      must(git(repoRoot, ["fetch", repo.remote, repo.integrationBranch]), "git fetch");
      must(git(repoRoot, ["worktree", "add", t.worktree, "-b", t.branch, t.baseSha]), "git worktree add");
      must(exec("node", ["tools/worktree-setup.mjs", "--base", t.baseSha], { cwd: t.worktree }), "worktree setup");
    }
    t.phase = "worktree";
    return save(t);
  }

  async function recon(t) {
    const files = must(git(t.worktree, ["ls-files"]), "git ls-files").split("\n").filter(Boolean);
    const read = readIn(t.worktree);
    const sel = selectContext({ files, ticketText: `${t.title}\n${t.body}`, readFile: read, excludes: config.contextExcludes, tokenCap: config.deepseek.contextTokenCap });
    const packet = renderScoutPacket({ ticket: t.n, title: t.title, body: t.body, map: sel.map, files: sel.chosen.map((c) => ({ path: c.path, content: read(c.path) ?? "" })) });
    let model = config.deepseek.scout.model;
    let res = await askChecked(t, { model, effort: config.deepseek.scout.effort, prefixFile: "scout-prefix.md", packet, purpose: "scout" });
    let checked = res.ok ? reviewRecon(res.artifact, read) : null;
    if (!res.ok || !checked.ok || checked.unverifiedShare > 0.2) {
      model = "deepseek-v4-pro";
      res = await askChecked(t, { model, effort: "low", prefixFile: "scout-prefix.md", packet, purpose: "scout-pro" });
      checked = res.ok ? reviewRecon(res.artifact, read) : null;
    }
    save(t);
    if (!res.ok) return block(t, `recon failed: ${res.code} ${res.message ?? ""}`.trim(), "re-run recon, or Sol scopes this ticket");
    if (!checked.ok) return block(t, `recon output invalid: ${checked.problems.join("; ")}`, "re-run recon, or Sol scopes this ticket");
    const r = res.artifact;
    t.recon = { model, verified: checked.verified.length, total: checked.total, unverified: checked.unverified.map((c) => c.claim), contextFiles: sel.chosen.map((c) => c.path) };
    writePrivate(t, "recon.json", r);
    if (r.contract_drift.length) return block(t, `contract drift: ${r.contract_drift.join("; ").slice(0, 400)}`, "Matthew: update the issue contract to match the current code");
    if (r.work_type !== "coding" || r.testable_done === "no") {
      return block(t, `Gate 0: scout classified this as ${r.work_type}, testable=${r.testable_done} (${r.testable_reason ?? ""})`.slice(0, 400), "Matthew: skip (interactive Claude session), run anyway, or split into testable coding tickets", "flagged");
    }
    t.phase = "recon";
    return save(t);
  }

  function reviewRecon(artifact, read) {
    const problems = validateRecon(artifact);
    if (problems.length) return { ok: false, problems };
    const v = verifyClaims(artifact.claims, read);
    return { ok: true, ...v, unverifiedShare: v.total ? v.unverified.length / v.total : 0 };
  }

  function triageView(t) {
    const r = readJson(ticketPath(t, "recon.json"));
    return [
      `### Ticket #${t.n}: ${t.title}`,
      `Acceptance class: ${t.acceptanceClass}; category: ${t.category}${overrides[t.category]?.minLane ? ` (owner override: minimum lane ${overrides[t.category].minLane})` : ""}; labels: ${t.labels.join(", ") || "none"}`,
      `Scout (${t.recon.model}): ${r.summary}`,
      `Work type: ${r.work_type}; testable done: ${r.testable_done} (${r.testable_reason ?? ""}); suggested lane: ${r.suggested_lane}`,
      `Risk flags: ${r.risk_flags.join(", ") || "none"}`,
      `Recon quotes verified: ${t.recon.verified}/${t.recon.total}${t.recon.unverified.length ? `; unverified claims dropped: ${t.recon.unverified.join(" | ").slice(0, 300)}` : ""}`,
      `Files to change: ${r.files_to_change.join(", ") || "none"}`,
      `Callers: ${r.callers.join(", ") || "none"}`,
      "Proposed cases:",
      ...r.proposed_cases.map((c) => `- ${c.id} (${c.kind ?? "normal"}): ${c.given} -> ${c.expect}`),
      ...(Array.isArray(r.slices) && r.slices.length ? ["Proposed slices:", ...r.slices.map((s) => `- ${s.id}: ${s.goal} [${(s.scope ?? []).join(", ")}] cases ${(s.cases ?? []).join(",")}`)] : []),
      "Open questions:",
      ...(r.open_questions.length ? r.open_questions.map((q) => `- ${q}`) : ["- none"]),
      "",
      "Issue contract:",
      t.body.slice(0, 6000),
    ].join("\n");
  }

  function claimCommand(t, role) {
    const sol = role === "sol";
    return [
      "env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs claim", t.n,
      '--execution-id "$CODEX_THREAD_ID"', "--branch", t.branch, "--start-commit", t.baseSha,
      "--model", config.codex.roles[sol ? "sol" : "controller"].model, "--effort medium --effective-effort high",
      "--allow-mismatch", shellQuote(sol ? "Sol coordinates; DeepSeek implements all slices" : "Luna controls; DeepSeek implements all slices"),
      "--worktree", t.worktreeName,
    ].join(" ");
  }

  // Apply a validated triage decision to the ticket. Returns the routing outcome.
  function adoptDecision(t, d) {
    const lane = applyCategoryOverrides(d.lane, t.category, overrides);
    Object.assign(t, { fit: d.fit, lane, laneDecided: d.lane, decisions: d.decisions ?? [], cases: d.cases ?? [], slices: normalizeSlices(d), sliceIndex: 0, realProcessChecks: d.real_process_checks ?? t.realProcessChecks ?? [] });
    writePrivate(t, "decisions.json", d);
    if (d.fit === "flag") return "flag";
    if (lane === "protected") return "protected";
    if (d.escalate) return "escalate";
    return "ok";
  }

  async function confirmClaim(t, threadId, role) {
    const inspected = await lifecycle.inspect(t.n);
    const live = inspected.ok ? inspected.claims?.live?.executionId : null;
    if (!live || live !== String(threadId).toLowerCase()) {
      return block(t, `claim identity mismatch: live claim ${live ?? "none"} vs session ${threadId}`, "reconcile the claim before any further work");
    }
    t.claimant = { threadId, role };
    t.phase = "claimed";
    return save(t);
  }

  // A category the owner raised to Protected skips Luna entirely.
  function routedToSolByCategory(t) {
    if (applyCategoryOverrides("express", t.category, overrides) !== "protected") return false;
    t.solReason = `category override: "${t.category}" is Protected`;
    t.phase = "needs-sol";
    save(t);
    return true;
  }

  // One Luna session triages one ticket and, when it may, claims it.
  async function triageAndClaim(t) {
    if (routedToSolByCategory(t)) return t;
    const res = await session(t, "controller", {
      step: "triage-and-claim",
      body: `${triageView(t)}\n\nDecide fit, lane, decisions, approved cases, write scope and (only if needed) slices. ${ONE_SLICE_RULE} Then, ONLY if fit is ok, lane is express or standard, and nothing is escalated, run the claim command below.`,
      commands: [claimCommand(t, "controller")],
      reply: `${triageReply(t.n)},"claimed":true|false,"claim_refusal":null|"CODE"}`,
    });
    if (!res.ok) return block(t, `triage session: ${res.code} ${res.message}`, "re-run the harness after the cause is fixed");
    const tri = validateTriage({ tickets: [res.decision] }, [t.n]);
    if (!tri.ok) return block(t, `triage output invalid: ${tri.problems.join("; ")}`, "re-run triage");
    const route = adoptDecision(t, res.decision);
    if (route === "flag") return block(t, "Gate 0: Controller flagged this ticket as not suited to delegated coding", "Matthew: skip, run anyway, or split", "flagged");
    if (route === "protected" || route === "escalate") {
      if (res.decision.claimed) return block(t, "Controller claimed a ticket it routed to Sol", "reconcile the claim; Sol takes the ticket");
      t.solReason = route === "protected" ? `lane protected${t.laneDecided !== t.lane ? ` (category override for ${t.category})` : ""}` : `escalated: ${res.decision.escalate}`;
      t.phase = "needs-sol";
      return save(t);
    }
    if (!res.decision.claimed) return block(t, `claim not made: ${res.decision.claim_refusal ?? "unknown"}`, "inspect the claim state; release only with stopped-execution evidence");
    return confirmClaim(t, res.threadId, "controller");
  }

  // One Luna session triages several tickets (no claims); each is then claimed separately.
  async function batchTriage(all) {
    const tickets = all.filter((t) => !routedToSolByCategory(t));
    if (tickets.length === 0) return all;
    const res = await session(tickets, "triage", {
      step: "batch-triage",
      cwd: repoRoot,
      body: `Triage each ticket below. Do not claim anything in this step. ${ONE_SLICE_RULE}\n\n${tickets.map(triageView).join("\n\n")}`,
      reply: `{"tickets":[${triageReply()}}]}`,
    });
    if (!res.ok) {
      for (const t of tickets) await block(t, `batch triage session: ${res.code} ${res.message}`, "re-run the harness after the cause is fixed");
      return all;
    }
    const tri = validateTriage(res.decision, tickets.map((t) => t.n));
    if (!tri.ok) {
      for (const t of tickets) await block(t, `batch triage output invalid: ${tri.problems.join("; ").slice(0, 300)}`, "re-run triage");
      return all;
    }
    for (const t of tickets) {
      const route = adoptDecision(t, tri.byN.get(t.n));
      if (route === "flag") await block(t, "Gate 0: Controller flagged this ticket as not suited to delegated coding", "Matthew: skip, run anyway, or split", "flagged");
      else if (route === "protected" || route === "escalate") {
        t.solReason = route === "protected" ? "lane protected" : `escalated: ${tri.byN.get(t.n).escalate}`;
        t.phase = "needs-sol";
        save(t);
      } else {
        t.phase = "triaged";
        save(t);
      }
    }
    return all;
  }

  async function claimAsController(t) {
    const res = await session(t, "controller", {
      step: "claim",
      body: `Ticket #${t.n}: ${t.title}\nTriage is done (lane ${t.lane}; ${t.cases.length} case(s); scope ${(t.slices ?? []).flatMap((s) => s.scope).join(", ")}). Run the claim command below.`,
      commands: [claimCommand(t, "controller")],
      reply: '{"claimed":true|false,"claim_refusal":null|"CODE"}',
    });
    if (!res.ok || res.decision.claimed !== true) return block(t, `claim not made: ${res.message ?? res.decision?.claim_refusal ?? "unknown"}`, "inspect the claim state; release only with stopped-execution evidence");
    return confirmClaim(t, res.threadId, "controller");
  }

  // Sol settles an escalated question or designs a Protected ticket, and claims it if Protected.
  async function solDesign(t) {
    const prior = readJson(ticketPath(t, "decisions.json"));
    const res = await session(t, "sol", {
      step: "design-and-claim",
      body: [
        `Reason you are called: ${t.solReason ?? "protected lane"}.`,
        prior ? `Controller's triage: ${JSON.stringify(prior)}` : "",
        "",
        triageView(t),
        "",
        "Settle every open question. Decide the lane. For a protected ticket: define the acceptance cases (every invariant), narrow write scopes, slices for pure sub-pieces, and the real-process checks you will run before review (disposable resources, synthetic credentials, outside the worktree). Then claim with the command below ONLY if the lane is protected. If the lane is express or standard, do not claim; the Controller will.",
        ONE_SLICE_RULE,
      ].filter(Boolean).join("\n"),
      commands: [claimCommand(t, "sol")],
      reply: `${triageReply(t.n)},"real_process_checks":["..."],"claimed":true|false,"claim_refusal":null|"CODE"}`,
    });
    if (!res.ok) return block(t, `Sol design session: ${res.code} ${res.message}`, "Sol takes this ticket interactively");
    const d = { ...res.decision, escalate: null };
    const tri = validateTriage({ tickets: [d] }, [t.n]);
    if (!tri.ok) return block(t, `Sol design output invalid: ${tri.problems.join("; ")}`, "Sol takes this ticket interactively");
    const route = adoptDecision(t, d);
    if (route === "flag") return block(t, "Sol flagged this ticket as not suited to delegated coding", "Matthew: skip, run anyway, or split", "flagged");
    if (route === "protected") {
      if (!t.realProcessChecks.length) return block(t, "Protected ticket without planned real-process checks", "Sol plans the real-process checks");
      if (!res.decision.claimed) return block(t, `Sol did not claim: ${res.decision.claim_refusal ?? "unknown"}`, "inspect the claim state");
      return confirmClaim(t, res.threadId, "sol");
    }
    if (res.decision.claimed) return block(t, "Sol claimed a ticket it routed to the Controller", "reconcile the claim");
    t.phase = "triaged";
    return save(t);
  }

  // ---- per-slice tests, ladder, quality checks -----------------------------------------

  function acceptancePathFor(t, slice) {
    return `${config.acceptanceDir}/delegate-${t.n}-${slice.id.toLowerCase()}-acceptance.test.js`;
  }

  function startSliceFields(t) {
    const slice = currentSlice(t);
    Object.assign(t, { scope: slice.scope, allow: slice.allow ?? [], sliceCases: casesFor(t, slice), attempts: [], ladder: null, repairs: 0, workerNotes: [], caseMap: [], redOnBase: null, mutants: null, preReview: null, lastGuards: null, lastAcceptance: null, lastRegression: null, acceptanceFiles: [] });
    t.lockedFiles ??= [];
  }

  async function acceptanceTests(t) {
    startSliceFields(t);
    const slice = currentSlice(t);
    const read = readIn(t.worktree);
    if (t.sliceCases.length === 0) {
      if (t.lane !== "express") return block(t, `no acceptance cases for ${slice.id} of a ${t.lane} ticket`, "re-triage");
      t.testBase = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
      t.baseTestCount = runSuite(t, "base-suite").counts.tests;
      t.phase = "tests";
      return save(t);
    }
    const acceptancePath = acceptancePathFor(t, slice);
    const sources = scopeFiles(t).map((p) => ({ path: p, content: read(p) ?? "" }));
    let problems = [];
    for (let round = 0; round < 2; round += 1) {
      const packet = renderTestAuthorPacket({ ticket: t.n, title: `${t.title} (${slice.id}: ${slice.goal})`, cases: t.sliceCases, acceptancePath, files: sources, exampleTest: exampleTest(t.worktree), contract: t.body.slice(0, 6000), problems });
      const res = await askChecked(t, { ...config.deepseek.testAuthor, prefixFile: "test-author-prefix.md", packet, purpose: `test-author-${slice.id}-${round + 1}` });
      save(t);
      if (!res.ok) { problems = [`${res.code}: ${res.message ?? ""}`]; continue; }
      const staged = stageArtifact(res.artifact, { allow: [acceptancePath], readFile: read });
      if (!staged.ok) { problems = [`${staged.code}: ${staged.message}`]; continue; }
      for (const [p, content] of staged.staged) writeFile(t.worktree, p, content);
      const red = failsForTheRightReason(acceptanceStatus(runJunit(t, [acceptancePath], `red-on-base-${slice.id}-${round + 1}`).parsed, t.sliceCases.map((c) => c.id)));
      if (red.ok) {
        t.caseMap = res.artifact.case_map ?? [];
        t.redOnBase = `${t.sliceCases.length}/${t.sliceCases.length} fail by assertion on base`;
        commitPaths(t, [acceptancePath], `test: acceptance cases for #${t.n} ${slice.id}`, `Model: DeepSeek (${config.deepseek.testAuthor.model}); written by the delegation harness test author.`);
        t.testBase = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
        t.acceptanceFiles = [acceptancePath];
        t.lockedFiles = [...new Set([...t.lockedFiles, acceptancePath])];
        t.lock = makeLock(t.lockedFiles, read);
        writePrivate(t, "acceptance.lock", t.lock);
        t.baseTestCount = runSuite(t, "base-suite").counts.tests;
        t.phase = "tests";
        return save(t);
      }
      problems = red.problems;
      fs.rmSync(path.join(t.worktree, acceptancePath), { force: true });
    }
    return block(t, `acceptance tests for ${slice.id} not proven red on base: ${problems.join("; ").slice(0, 300)}`, "the Controller or Sol revises the cases");
  }

  function scopeFiles(t) {
    return [...new Set((t.scope ?? []).flatMap((g) => listMatching(t.worktree, g)))].slice(0, 20);
  }

  function commitPaths(t, paths, subject, body) {
    if (!paths.length) return;
    must(git(t.worktree, ["add", "--", ...paths]), "git add");
    must(git(t.worktree, ["commit", "-m", subject, "-m", body]), "git commit");
  }

  function runJunit(t, files, label) {
    const out = path.join(state.ticketDir(t.n), "junit", `${label}.xml`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    const res = exec("node", ["--test", "--test-reporter=junit", `--test-reporter-destination=${out}`, ...files], { cwd: t.worktree });
    const xml = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    return { exitCode: res.status, parsed: parseJunit(xml) };
  }

  function runSuite(t, label) {
    const run = runJunit(t, listMatching(t.worktree, config.testGlob), label);
    return { exitCode: run.exitCode, counts: run.parsed.counts, parsed: run.parsed };
  }

  function gatherFacts(t) {
    const base = t.testBase;
    const numstat = parseNumstat(must(git(t.worktree, ["diff", "--no-renames", "--numstat", base]), "git diff numstat"));
    const untracked = parseUntracked(must(git(t.worktree, ["status", "--porcelain=v1", "-uall"]), "git status"));
    const read = readIn(t.worktree);
    const summary = summarizeChanges({ numstat, untracked, readFile: read });
    const added = parseAddedLines(must(git(t.worktree, ["diff", "--no-renames", "-U0", base]), "git diff"));
    for (const [p, lines] of summary.addedLines) added.set(p, lines);
    const changedPaths = summary.files.map((f) => f.path);
    const syntaxErrors = changedPaths
      .filter((p) => /\.m?js$/.test(p) && read(p) !== null)
      .map((p) => ({ p, r: exec("node", ["--check", p], { cwd: t.worktree }) }))
      .filter(({ r }) => r.status !== 0)
      .map(({ p, r }) => `${p}: ${(r.stderr.split("\n").find((l) => /Error/.test(l)) ?? "syntax error").trim()}`);
    const whitespace = git(t.worktree, ["diff", "--check", base]);
    return {
      changedPaths,
      addedLines: added,
      totals: summary.totals,
      lockMismatches: t.lock ? lockMismatches(t.lock, read) : [],
      baseTestCount: t.baseTestCount ?? null,
      testCount: undefined, // measured after the static guards pass
      syntaxErrors,
      whitespaceErrors: whitespace.status === 0 ? "" : whitespace.stdout,
    };
  }

  function acceptanceRun(t, label) {
    return acceptanceStatus(runJunit(t, t.acceptanceFiles, label).parsed, t.sliceCases.map((c) => c.id));
  }

  function evaluate(t) {
    const facts = gatherFacts(t);
    const ticket = { lane: t.lane, writeScope: t.scope, harnessPaths: [], allow: t.allow };
    let guards = staticGuards(facts, ticket, config);
    let failingTests = [];
    if (guards.every((g) => g.ok)) {
      const suite = runSuite(t, `suite-${Date.now()}`);
      facts.testCount = Number.isFinite(suite.counts.tests) ? suite.counts.tests : null;
      guards = staticGuards(facts, ticket, config);
      let testResults;
      if (t.acceptanceFiles.length) {
        const label = `acceptance-${Date.now()}`;
        const acc = runJunit(t, t.acceptanceFiles, label);
        const status = acceptanceStatus(acc.parsed, t.sliceCases.map((c) => c.id));
        testResults = testGuards({ acceptanceStatusById: status, regression: suite });
        failingTests = acc.parsed.cases.filter((c) => c.status === "failed");
        t.lastAcceptance = Object.entries(status).map(([id, s]) => `${id} ${s.failed || s.skipped || !s.found ? "FAIL" : "PASS"}`).join("  ");
      } else {
        testResults = regressionOnlyGuards({ regression: suite });
        t.lastAcceptance = "none (express: regression suite only)";
      }
      failingTests = [...failingTests, ...suite.parsed.cases.filter((c) => c.status === "failed")];
      t.lastRegression = `${suite.counts.pass}/${suite.counts.tests} passed, exit ${suite.exitCode}`;
      guards = [...guards, ...testResults];
    }
    const { outcome } = classify(guards);
    t.lastGuards = formatGuardLines(guards);
    return { outcome, guards, failure: failureExcerpt({ guards, failingTests }), diff: workerDiff(t) };
  }

  function workerDiff(t) {
    const tracked = git(t.worktree, ["diff", "--no-renames", t.testBase]).stdout;
    const untracked = parseUntracked(git(t.worktree, ["status", "--porcelain=v1", "-uall"]).stdout);
    const read = readIn(t.worktree);
    const added = untracked.map((p) => `--- /dev/null\n+++ b/${p}\n${(read(p) ?? "").split("\n").map((l) => `+${l}`).join("\n")}`).join("\n");
    return [tracked, added].filter(Boolean).join("\n");
  }

  // Files the worker changed since testBase, inside the write scope.
  function workerPaths(t) {
    return gatherFacts(t).changedPaths.filter((p) => !(t.lockedFiles ?? []).includes(p));
  }

  function snapshotPaths(t, paths) {
    const read = readIn(t.worktree);
    return Object.fromEntries(paths.map((p) => [p, read(p)]));
  }

  function restoreSnapshot(t, snapshot) {
    for (const [p, content] of Object.entries(snapshot)) {
      if (content === null) fs.rmSync(path.join(t.worktree, p), { force: true });
      else writeFile(t.worktree, p, content);
    }
  }

  // Scratch edits (mutants, base checks) are backed up first, so a crash mid-check
  // is undone on resume. Checks nest (a mutant inside a strengthening round), so
  // each level has its own backup and recovery restores innermost first.
  let scratchDepth = 0;
  function withScratch(t, paths, fn) {
    const marker = ticketPath(t, `scratch-${scratchDepth}.json`);
    const snapshot = snapshotPaths(t, paths);
    writeJsonAtomic(marker, snapshot);
    scratchDepth += 1;
    try {
      return fn();
    } finally {
      scratchDepth -= 1;
      restoreSnapshot(t, snapshot);
      fs.rmSync(marker, { force: true });
    }
  }

  function recoverScratch(t) {
    if (!t.worktree) return;
    let names = [];
    try { names = fs.readdirSync(state.ticketDir(t.n)).filter((f) => /^scratch-\d+\.json$/.test(f)); } catch { return; }
    names.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    for (const name of names) {
      const snapshot = readJson(ticketPath(t, name));
      if (snapshot) restoreSnapshot(t, snapshot);
      fs.rmSync(ticketPath(t, name), { force: true });
    }
    if (names.length) log(`#${t.n}: restored files from an interrupted check`);
  }

  function restoreBase(t) {
    const read = readIn(t.worktree);
    for (const p of gatherFacts(t).changedPaths) {
      if ((t.lockedFiles ?? []).includes(p) || !matchesAny(p, t.scope)) continue;
      const atBase = git(t.worktree, ["show", `${t.testBase}:${p}`]);
      if (atBase.status === 0) writeFile(t.worktree, p, atBase.stdout);
      else if (read(p) !== null) fs.rmSync(path.join(t.worktree, p), { force: true });
    }
  }

  async function runImplementation(t, { startRung = 0, note = null, maxAttempts = Infinity } = {}) {
    const read = readIn(t.worktree);
    restoreBase(t); // every ladder run starts from the committed tests
    const slice = currentSlice(t);
    return runLadder({
      rungs: config.ladder,
      startRung,
      note,
      maxAttempts,
      deps: {
        spendCheck: spendGuard(),
        restoreBase: async () => restoreBase(t),
        callModel: async (rung, { previous, note: n }) => {
          const files = [...new Set([...scopeFiles(t), ...t.acceptanceFiles])].map((p) => ({ path: p, content: read(p) ?? "" }));
          const packet = renderWorkerPacket({
            ticket: t.n, title: `${t.title} (${slice.id}: ${slice.goal})`, lane: t.lane, baseSha: t.testBase, runtime: `Node ${process.versions.node}, ES modules, node:test`,
            goal: slice.goal === "the whole ticket" ? firstSection(t.body, "Outcome") || t.title : slice.goal, contract: t.body.slice(0, 6000), decisions: t.decisions, cases: t.sliceCases,
            scope: t.scope, allow: t.allow, acceptanceFiles: t.lockedFiles ?? [], files, note: n, previous,
          });
          return askDeepSeek(t, { model: rung.model, effort: rung.effort, prefixFile: "worker-prefix.md", packet, failure: previous?.failure ?? "", purpose: `implement-${slice.id}-${rung.model}-${rung.effort}` });
        },
        apply: async (artifact) => {
          const staged = stageArtifact(artifact, { allow: t.scope, locked: t.lockedFiles ?? [], readFile: read });
          if (!staged.ok) return staged;
          for (const [p, content] of staged.staged) writeFile(t.worktree, p, content);
          t.workerNotes = [...(artifact.notes ?? []), ...(artifact.summary ? [artifact.summary] : [])];
          return { ok: true };
        },
        evaluate: async () => evaluate(t),
        record: (entry) => {
          t.attempts = [...(t.attempts ?? []), { ...entry, guards: undefined, guardLines: entry.guards ? formatGuardLines(entry.guards) : undefined }];
          save(t);
        },
      },
    });
  }

  async function implement(t, opts = {}) {
    const pending = t.pendingRun ?? null;
    const startRung = opts.startRung ?? pending?.startRung ?? ladderStartFor(t.category, overrides);
    const note = opts.note ?? pending?.note ?? null;
    t.pendingRun = { startRung, note };
    save(t);
    const result = await runImplementation(t, { startRung: Math.min(startRung, config.ladder.length - 1), note });
    t.ladder = { outcome: result.outcome, code: result.code ?? null, message: result.message ?? null };
    if (result.outcome === "STOPPED") {
      // Back to "tests": on resume the same run (rung and note) starts again from the committed tests.
      t.phase = "tests";
      save(t);
      throw stop(result.code ?? "STOPPED", `batch stopped: ${result.code} ${result.message ?? ""}`);
    }
    t.pendingRun = null;
    if (result.outcome === "PROMOTE_PROTECTED") return block(t, "the change touches protected paths", "Sol re-scopes this ticket in the Protected lane");
    if (result.outcome === "PROMOTE_LANE") return block(t, `the change exceeds the ${t.lane} lane limits`, "re-triage in a higher lane, or split the ticket");
    if (result.outcome === "SPLIT_NEEDED") return block(t, "DeepSeek output limit hit twice; the slice is too large", "split the ticket into smaller slices");
    t.mutants = null;
    t.preReview = null;
    t.phase = "implemented";
    return save(t);
  }

  // Mutant check and pre-review (Standard and Protected lanes, green ladders only).
  async function qualityChecks(t) {
    if (t.lane !== "express" && t.ladder?.outcome === "GREEN" && t.acceptanceFiles.length) {
      await mutantCheck(t);
      if (isTerminal(t.phase)) return t;
      await preReview(t);
      if (isTerminal(t.phase)) return t;
    }
    t.phase = "checked";
    return save(t);
  }

  async function mutantCheck(t) {
    const read = readIn(t.worktree);
    const files = scopeFiles(t).map((p) => ({ path: p, content: read(p) ?? "" }));
    const res = await askChecked(t, { ...config.deepseek.mutants, prefixFile: "mutant-prefix.md", packet: renderMutantPacket({ ticket: t.n, title: t.title, cases: t.sliceCases, scope: t.scope, lockedFiles: t.lockedFiles, files }), purpose: `mutants-${currentSlice(t).id}` });
    if (!res.ok || !Array.isArray(res.artifact?.mutants)) {
      t.mutants = { total: 0, killed: 0, survivors: [], note: `mutant writer failed: ${res.code ?? "no mutants"}` };
      return save(t);
    }
    const valid = [];
    for (const m of res.artifact.mutants.slice(0, 3)) {
      if (!m || !Array.isArray(m.edits)) continue;
      const staged = stageArtifact({ status: "done", edits: m.edits }, { allow: t.scope, locked: t.lockedFiles, readFile: read });
      if (!staged.ok) continue;
      if ([...staged.staged].every(([p, c]) => c === read(p))) continue; // no behavior change
      valid.push({ name: String(m.name ?? `mutant-${valid.length + 1}`).slice(0, 60), mistake: String(m.mistake ?? "").slice(0, 200), edits: m.edits, staged: staged.staged });
    }
    const runMutant = (m) => withScratch(t, [...m.staged.keys()], () => {
      for (const [p, c] of m.staged) writeFile(t.worktree, p, c);
      const status = acceptanceRun(t, `mutant-${m.name}-${Date.now()}`);
      return !acceptancePassed(status).ok; // killed when any acceptance case fails
    });
    let survivors = valid.filter((m) => !runMutant(m));
    let strengthened = false;
    if (survivors.length) {
      const outcome = await strengthenTests(t, survivors);
      strengthened = outcome.ok;
      if (outcome.ok) survivors = survivors.filter((m) => !runMutant(m));
      else t.mutantStrengthenProblem = outcome.problem;
    }
    t.mutants = { total: valid.length, killed: valid.length - survivors.length, survivors: survivors.map((m) => `${m.name}: ${m.mistake}`), strengthened, note: valid.length ? null : "no valid mutants produced" };
    return save(t);
  }

  // One round: the test author sharpens the tests so the survivors fail, keeping
  // the real implementation green and the tests red on base. Then re-locked.
  async function strengthenTests(t, survivors) {
    const read = readIn(t.worktree);
    const acceptancePath = t.acceptanceFiles[0];
    const original = read(acceptancePath);
    const packet = renderTestAuthorPacket({
      ticket: t.n, title: t.title, cases: t.sliceCases, acceptancePath, files: scopeFiles(t).map((p) => ({ path: p, content: read(p) ?? "" })),
      exampleTest: "", contract: t.body.slice(0, 4000), survivors, currentTests: original,
    });
    const res = await askChecked(t, { ...config.deepseek.testAuthor, prefixFile: "test-author-prefix.md", packet, purpose: `strengthen-${currentSlice(t).id}` });
    if (!res.ok) return { ok: false, problem: `${res.code}` };
    const staged = stageArtifact(res.artifact, { allow: [acceptancePath], readFile: read });
    if (!staged.ok) return { ok: false, problem: staged.code };
    const content = staged.staged.get(acceptancePath);
    const ids = t.sliceCases.map((c) => c.id);
    const verdict = withScratch(t, [acceptancePath], () => {
      writeFile(t.worktree, acceptancePath, content);
      if (!acceptancePassed(acceptanceRun(t, `strengthen-green-${Date.now()}`)).ok) return "new tests fail on the real implementation";
      for (const m of survivors) {
        const killed = withScratch(t, [...m.staged.keys()], () => {
          for (const [p, c] of m.staged) writeFile(t.worktree, p, c);
          return !acceptancePassed(acceptanceRun(t, `strengthen-mutant-${Date.now()}`)).ok;
        });
        if (!killed) return `mutant ${m.name} still passes`;
      }
      const worker = workerPaths(t).filter((p) => p !== acceptancePath);
      const red = withScratch(t, worker, () => {
        restoreBase(t);
        return failsForTheRightReason(acceptanceStatus(runJunit(t, [acceptancePath], `strengthen-red-${Date.now()}`).parsed, ids));
      });
      return red.ok ? null : `not red on base: ${red.problems.join("; ")}`;
    });
    if (verdict) return { ok: false, problem: verdict };
    writeFile(t.worktree, acceptancePath, content);
    commitPaths(t, [acceptancePath], `test: strengthen acceptance for #${t.n} ${currentSlice(t).id}`, `Model: DeepSeek (${config.deepseek.testAuthor.model}); written after a mutant survived the first tests.`);
    t.testBase = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
    t.lock = makeLock(t.lockedFiles, read);
    writePrivate(t, "acceptance.lock", t.lock);
    t.baseTestCount = Math.max(t.baseTestCount ?? 0, runSuite(t, "suite-strengthened").counts.tests);
    evaluate(t); // refresh the evidence lines against the new tests
    save(t);
    return { ok: true };
  }

  async function preReview(t) {
    const read = readIn(t.worktree);
    const ask = async (label) => {
      const packet = renderPreReviewPacket({ ticket: t.n, title: t.title, contract: t.body.slice(0, 6000), decisions: t.decisions, cases: t.sliceCases, caseMap: t.caseMap, scope: t.scope, tests: t.acceptanceFiles.map((p) => `=== ${p} ===\n${read(p) ?? ""}`).join("\n"), diff: workerDiff(t).split("\n").slice(0, 600).join("\n") });
      const res = await askChecked(t, { ...config.deepseek.preReview, prefixFile: "pre-review-prefix.md", packet, purpose: `pre-review-${currentSlice(t).id}-${label}` });
      if (!res.ok || !Array.isArray(res.artifact?.findings)) return { ok: false, findings: [], note: `pre-review unavailable (${res.code ?? "shape"})` };
      return { ok: true, findings: res.artifact.findings.filter((f) => f && typeof f.issue === "string").slice(0, 10).map((f) => `${f.path ?? "?"}:${f.line ?? "?"} ${f.issue}`.slice(0, 300)) };
    };
    const first = await ask("1");
    if (!first.ok || first.findings.length === 0) {
      t.preReview = { findings: [], note: first.note ?? null, extraAttempt: null };
      return save(t);
    }
    // One more implementer attempt with the findings; keep the green version if it regresses.
    const keep = snapshotPaths(t, workerPaths(t));
    const result = await runImplementation(t, { startRung: config.repairStartRung, note: `Pre-review findings to fix:\n${first.findings.join("\n")}`, maxAttempts: 1 });
    if (result.outcome === "STOPPED") throw stop(result.code ?? "STOPPED", `batch stopped: ${result.code}`);
    let extra = "fixed";
    if (result.outcome !== "GREEN") {
      restoreBase(t);
      restoreSnapshot(t, keep);
      evaluate(t);
      extra = `attempt ${result.outcome}; kept the previous green version`;
      t.preReview = { findings: first.findings, extraAttempt: extra };
      return save(t);
    }
    const second = await ask("2");
    t.preReview = { findings: second.findings, extraAttempt: extra, note: second.note ?? null };
    return save(t);
  }

  // ---- bundle, gate, escalation ---------------------------------------------------------

  function bundle(t) {
    const slice = currentSlice(t);
    const lines = t.lastGuards ?? [];
    const m = t.mutants;
    const pr = t.preReview;
    const r = renderBundle({
      ticket: t.n, title: `${t.title}${(t.slices ?? []).length > 1 ? ` (slice ${slice.id} of ${t.slices.length}: ${slice.goal})` : ""}`, lane: t.lane, baseSha: t.testBase, attempts: t.attempts ?? [],
      deepseekUsd: t.deepseek?.usdEstimate ?? null, cacheHitPercent: cacheHit(t), models: [...new Set((t.deepseek?.requests ?? []).map((q) => q.model).filter(Boolean))],
      decisions: t.decisions, cases: t.sliceCases, caseMap: t.caseMap ?? [], guardsPassed: lines.filter((l) => l.startsWith("PASS")).length, guardsTotal: lines.length, guardLines: lines,
      acceptanceLine: t.lastAcceptance, regressionLine: t.lastRegression, redOnBaseLine: t.redOnBase ?? "n/a", reconLine: t.recon ? `${t.recon.verified}/${t.recon.total} verified` : "n/a",
      mutantLine: m ? `${m.killed}/${m.total} killed${m.strengthened ? " (tests strengthened once)" : ""}${m.survivors.length ? `; SURVIVED: ${m.survivors.join("; ")}` : ""}${m.note ? `; ${m.note}` : ""}` : t.lane === "express" ? "not run (express)" : "not run (ladder not green)",
      preReviewLine: pr ? `${pr.findings.length ? pr.findings.join(" | ") : "NONE"}${pr.extraAttempt ? ` (extra attempt: ${pr.extraAttempt})` : ""}${pr.note ? `; ${pr.note}` : ""}` : t.lane === "express" ? "not run (express)" : "not run (ladder not green)",
      workerNotes: t.workerNotes ?? [], diff: workerDiff(t), diffStat: git(t.worktree, ["diff", "--no-renames", "--stat", t.baseSha]).stdout,
    });
    if (!r.ok) return r;
    writePrivate(t, `bundle-${slice.id}.md`, r.text);
    return { ok: true, text: r.text };
  }

  async function gateDecision(t) {
    const b = bundle(t);
    if (!b.ok) return block(t, `bundle refused: ${b.message}`, "split the ticket or escalate to Sol");
    const green = t.ladder?.outcome === "GREEN";
    const role = t.claimant.role;
    const res = await session(t, role, {
      step: "gate",
      resumeId: t.claimant.threadId,
      body: `${green ? "The ladder finished GREEN." : `The ladder did NOT finish green (${t.ladder?.outcome}); ACCEPT is not available.`}\n\n${b.text}`,
      reply: role === "sol" ? '{"decision":"ACCEPT|REPAIR|RECLAIM","note":"<=5 lines"}' : '{"decision":"ACCEPT|REPAIR|ESCALATE|RECLAIM","note":"<=5 lines, required for REPAIR/ESCALATE/RECLAIM"}',
    });
    if (!res.ok) return block(t, `gate session: ${res.code} ${res.message}`, "re-run the harness after the cause is fixed");
    let decision = String(res.decision.decision ?? "").toUpperCase();
    const note = String(res.decision.note ?? "").split("\n").slice(0, 5).join("\n");
    if (decision === "ACCEPT" && !green) decision = role === "sol" ? "RECLAIM" : "ESCALATE";
    if (decision === "REPAIR" && (t.repairs ?? 0) >= 1) decision = role === "sol" ? "RECLAIM" : "ESCALATE";
    if (decision === "ESCALATE" && role === "sol") decision = "RECLAIM";
    t.decisionsLog = [...(t.decisionsLog ?? []), { by: role, slice: currentSlice(t).id, decision, note }];
    save(t);
    return applyDecision(t, decision, note, role);
  }

  async function applyDecision(t, decision, note, by) {
    if (decision === "ACCEPT") return acceptSlice(t);
    if (decision === "REPAIR") {
      t.repairs = (t.repairs ?? 0) + 1;
      save(t);
      await implement(t, { startRung: config.repairStartRung, note });
      if (isTerminal(t.phase)) return t;
      await qualityChecks(t);
      if (isTerminal(t.phase)) return t;
      return gateDecision(t);
    }
    if (decision === "ESCALATE" && by === "controller") return escalate(t, note);
    if (["RECLAIM", "PROTECTED", "ESCALATE"].includes(decision)) {
      return block(t, `${by} ${decision.toLowerCase()} (${currentSlice(t).id}): ${note}`, decision === "PROTECTED" ? "Sol re-scopes this ticket in the Protected lane" : "re-slice or redesign before further work");
    }
    return block(t, `unknown decision ${decision} from ${by}`, "inspect the session output");
  }

  async function escalate(t, reason) {
    t.escalated = true;
    const res = await session(t, "sol", {
      step: "escalation",
      cwd: t.worktree,
      body: `Controller's reason: ${reason}\n\n${fs.readFileSync(ticketPath(t, `bundle-${currentSlice(t).id}.md`), "utf8")}`,
      reply: '{"decision":"ACCEPT|REPAIR|RECLAIM|PROTECTED","note":"<=5 lines","reason":"..."}',
    });
    if (!res.ok) return block(t, `Sol escalation session: ${res.code} ${res.message}`, "Sol reviews this ticket interactively");
    let decision = String(res.decision.decision ?? "").toUpperCase();
    if (decision === "ACCEPT" && t.ladder?.outcome !== "GREEN") decision = "RECLAIM";
    if (decision === "REPAIR" && (t.repairs ?? 0) >= 2) decision = "RECLAIM";
    t.decisionsLog = [...(t.decisionsLog ?? []), { by: "sol", slice: currentSlice(t).id, decision, note: res.decision.note ?? "" }];
    save(t);
    if (decision === "REPAIR") {
      t.repairs = (t.repairs ?? 0) + 1;
      save(t);
      await implement(t, { startRung: config.repairStartRung, note: String(res.decision.note ?? "") });
      if (isTerminal(t.phase)) return t;
      await qualityChecks(t);
      if (isTerminal(t.phase)) return t;
      bundle(t);
      if (t.ladder?.outcome !== "GREEN") return block(t, "Sol-directed repair did not reach green", "Sol takes this ticket in the Protected lane");
      return acceptSlice(t);
    }
    return applyDecision(t, decision, String(res.decision.note ?? ""), "sol");
  }

  // Commit the accepted slice and move to the next one, or on to publishing.
  function acceptSlice(t) {
    const slice = currentSlice(t);
    const paths = workerPaths(t);
    const models = [...new Set((t.attempts ?? []).filter((a) => a.result === "GREEN").map((a) => `${a.model}/${a.effort}`))];
    commitPaths(t, paths, `feat: ${t.title} (#${t.n})${(t.slices ?? []).length > 1 ? ` [${slice.id}: ${slice.goal}]` : ""}`.slice(0, 200), `Model: DeepSeek (${models.join(", ") || "unknown"}); applied and checked by the delegation harness.`);
    const commit = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
    t.doneSlices = [...(t.doneSlices ?? []), {
      id: slice.id, goal: slice.goal, commit, attempts: t.attempts, ladder: t.ladder, repairs: t.repairs, caseMap: t.caseMap, redOnBase: t.redOnBase,
      lastGuards: t.lastGuards, lastAcceptance: t.lastAcceptance, lastRegression: t.lastRegression, mutants: t.mutants, preReview: t.preReview, workerNotes: t.workerNotes,
    }];
    t.sliceIndex = (t.sliceIndex ?? 0) + 1;
    if (t.sliceIndex < (t.slices ?? []).length) {
      t.phase = "claimed"; // next slice: tests, ladder, checks, gate
    } else {
      t.phase = t.lane === "protected" ? "rpc" : "accepted";
    }
    return save(t);
  }

  // Protected lane: Sol runs the planned real-process checks before review.
  async function realProcessCheck(t) {
    const res = await session(t, "sol", {
      step: "real-process-check",
      resumeId: t.claimant.threadId,
      body: [
        `All ${t.doneSlices.length} slice(s) of #${t.n} are accepted and committed on ${t.branch} (HEAD ${must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim()}).`,
        "Run the real-process checks you planned, against this checkout, with disposable resources and synthetic credentials. Do not edit files in the worktree; put any scratch files under $TMPDIR.",
        "Planned checks:",
        ...t.realProcessChecks.map((c) => `- ${c}`),
      ].join("\n"),
      reply: '{"passed":true|false,"evidence":["command -> observed result"],"failure":null|"..."}',
    });
    if (!res.ok) return block(t, `real-process check session: ${res.code} ${res.message}`, "Sol runs the checks interactively");
    const evidence = Array.isArray(res.decision.evidence) ? res.decision.evidence.map(String).slice(0, 12) : [];
    t.realProcessEvidence = evidence;
    if (res.decision.passed !== true || evidence.length === 0) return block(t, `real-process check failed: ${res.decision.failure ?? "no evidence"}`, "Sol decides the fix; DeepSeek implements it");
    t.phase = "accepted";
    return save(t);
  }

  // ---- publish, review, verify, finish ---------------------------------------------------

  function allSlices(t) {
    return t.doneSlices ?? [];
  }

  function publish(t) {
    if (t.publishedSha) { t.phase = "pushed"; return save(t); }
    const dirty = git(t.worktree, ["status", "--porcelain=v1", "-uall"]).stdout.trim();
    if (dirty) return block(t, `uncommitted changes at publish: ${dirty.split("\n").slice(0, 5).join(", ")}`, "inspect the worktree; only accepted slices are published");
    const evidencePath = `${config.evidenceDir}/${t.n}.md`;
    writeFile(t.worktree, evidencePath, evidenceText(t));
    commitPaths(t, [evidencePath], `docs: delegation evidence for #${t.n}`, "Written by the delegation harness.");
    t.publishedSha = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
    must(git(t.worktree, ["push", "-u", repo.remote, t.branch]), "git push");
    t.phase = "pushed";
    return save(t);
  }

  async function openPr(t) {
    if (!t.prNumber) {
      // Re-read first: an earlier POST may have succeeded with an uncertain answer.
      const existing = await gate.rest({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${repo.owner}:${t.branch}`)}&state=all` });
      if (!existing.ok) throw stop(existing.code, `read PRs: ${existing.message}`);
      const found = Array.isArray(existing.data) ? existing.data.find((pr) => pr.head?.ref === t.branch) : null;
      if (found) {
        t.prNumber = found.number;
        t.prUrl = found.html_url;
      } else {
        const res = await gate.rest({ method: "POST", path: `/repos/${repo.owner}/${repo.name}/pulls`, body: { title: `${t.title} (#${t.n})`, head: t.branch, base: repo.integrationBranch, body: prBody(t) } });
        if (!res.ok) throw stop(res.code, `open PR: ${res.message} (re-run: the harness re-reads before retrying)`);
        t.prNumber = res.data?.number;
        t.prUrl = res.data?.html_url;
      }
    }
    t.phase = "published";
    return save(t);
  }

  function harnessEvidence(t) {
    const slices = allSlices(t);
    const last = slices.at(-1) ?? {};
    const guardPass = slices.every((s) => (s.lastGuards ?? []).every((l) => l.startsWith("PASS")));
    const parts = [
      `harness: ${last.lastRegression ?? "n/a"}`,
      `acceptance ${slices.map((s) => `${s.id} ${s.lastAcceptance}`).join("; ")}`,
      `guards ${guardPass ? "all PASS" : "see bundle"}`,
      `mutants ${slices.map((s) => (s.mutants ? `${s.mutants.killed}/${s.mutants.total}` : "n/a")).join(",")}`,
      `pre-review ${slices.map((s) => (s.preReview ? (s.preReview.findings.length ? `${s.preReview.findings.length} finding(s)` : "NONE") : "n/a")).join(",")}`,
      `at ${t.publishedSha}`,
    ];
    if (t.realProcessEvidence?.length) parts.push(`Sol real-process checks: ${t.realProcessEvidence.join(" | ")}`);
    return parts.join("; ").slice(0, 1500);
  }

  async function review(t) {
    const unrun = [];
    for (const s of allSlices(t)) {
      if (!s.mutants) unrun.push(`${s.id} mutant check (express or not green)`);
      if (!s.preReview) unrun.push(`${s.id} pre-review (express or not green)`);
    }
    const cmd = [
      "env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs review", t.n,
      '--execution-id "$CODEX_THREAD_ID"', "--commit", t.publishedSha,
      "--commands", shellQuote(harnessEvidence(t)),
      "--exclusions", shellQuote(unrun.length ? `not run: ${unrun.join("; ")}` : "none"),
      "--outstanding", shellQuote(t.acceptanceClass === "Producer" ? "owner acceptance of this exact commit" : "independent verification of this exact commit"),
      "--branch", t.branch,
    ].join(" ");
    const res = await session(t, t.claimant.role, {
      step: "review",
      resumeId: t.claimant.threadId,
      body: `The harness published ${t.publishedSha} on ${t.branch} (PR ${t.prUrl ?? t.prNumber}). Record the lifecycle review with the command below. The --commands text is harness evidence, labelled as such.`,
      commands: [cmd],
      reply: '{"reviewed":true|false,"refusal":null|"CODE"}',
    });
    if (!res.ok || res.decision.reviewed !== true) return block(t, `review not recorded: ${res.message ?? res.decision?.refusal ?? "unknown"}`, "the claimant records the review");
    const inspected = await lifecycle.inspect(t.n);
    if (!inspected.ok || inspected.review?.commit !== t.publishedSha) return block(t, "review record does not name the published SHA", "reconcile the review record");
    t.phase = "reviewed";
    return save(t);
  }

  async function verify(t) {
    const verifyCmd = ["env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs verify", t.n, '--execution-id "$CODEX_THREAD_ID"', "--commit", t.publishedSha, '--checks "$CHECKS"'].join(" ");
    const caseIds = (t.cases ?? []).map((c) => c.id);
    const res = await session(t, "verifier", {
      step: "verify",
      cwd: repoRoot,
      body: [
        "Run the first command. Only if its summary ends with RESULT: PASS and matches the evidence below, run the second command with CHECKS filled from the summary.",
        `Ticket #${t.n}, published SHA ${t.publishedSha}.`,
        `Base test count: ${t.baseTestCount}. Approved cases: ${caseIds.join(", ") || "none (express)"}.`,
        `Harness evidence: ${harnessEvidence(t)}`,
      ].join("\n"),
      commands: [`node tools/delegate/run.mjs check-sha ${t.publishedSha} --ticket ${t.n}`, `CHECKS='<one line: npm ci result; npm test counts; acceptance results, copied from the summary>' ${verifyCmd}`],
      reply: '{"verified":true|false,"sha":"<full sha>","mismatch":null|"..."}',
    });
    if (!res.ok || res.decision.verified !== true) return block(t, `verification failed: ${res.message ?? res.decision?.mismatch ?? "unknown"}`, "Sol reviews the mismatch");
    const inspected = await lifecycle.inspect(t.n);
    if (!inspected.ok || inspected.independentVerification !== true) return block(t, "no independent verification record for the reviewed commit", "reconcile the verify record");
    t.phase = "verified";
    return save(t);
  }

  async function finish(t) {
    if (stopBeforeMerge && t.acceptanceClass === "Automated") {
      // Pilot mode (--no-merge): verified and published, but the owner merges and completes.
      writePrivate(t, "signoff.md", `${signoffText(t)}\nPilot run (--no-merge): after reviewing, merge PR ${t.prUrl ?? t.prNumber} with a merge commit (no squash or rebase), run npm test on main, then: node scripts/roadmap/lifecycle.mjs complete ${t.n}\n`);
      t.phase = "awaiting-owner";
      t.stoppedBeforeMerge = true;
      save(t);
      ledger(t, "awaiting-owner");
      log(`#${t.n} verified; stopped before merge (--no-merge). Next steps: ${ticketPath(t, "signoff.md")}`);
      return t;
    }
    if (t.acceptanceClass === "Producer") {
      writePrivate(t, "signoff.md", signoffText(t));
      t.phase = "awaiting-owner";
      save(t);
      ledger(t, "awaiting-owner");
      log(`#${t.n} awaits Matthew's sign-off: ${ticketPath(t, "signoff.md")}`);
      return t;
    }
    if (t.acceptanceClass !== "Automated") return block(t, `acceptance class ${t.acceptanceClass} is not finished by the harness`, "owner handles acceptance");
    const pr = await gate.rest({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls/${t.prNumber}` });
    if (!pr.ok) throw stop(pr.code, `read PR: ${pr.message}`);
    if (pr.data?.head?.sha !== t.publishedSha) return block(t, `PR head ${pr.data?.head?.sha} is not the verified SHA ${t.publishedSha}`, "owner reconciles the PR before merging");
    if (!pr.data?.merged) {
      // A merge commit preserves the verified SHA (no squash, no rebase).
      const merged = await gate.rest({ method: "PUT", path: `/repos/${repo.owner}/${repo.name}/pulls/${t.prNumber}/merge`, body: { merge_method: "merge", sha: t.publishedSha } });
      if (!merged.ok) return block(t, `merge refused: ${merged.message}`, "owner merges after checking the PR");
    }
    must(git(repoRoot, ["fetch", repo.remote, repo.integrationBranch]), "git fetch");
    const remoteMain = `${repo.remote}/${repo.integrationBranch}`;
    if (git(repoRoot, ["merge-base", "--is-ancestor", t.publishedSha, remoteMain]).status !== 0) return block(t, "verified SHA is not reachable from main after merge", "owner checks the merge");
    const mainCheck = checkSha(must(git(repoRoot, ["rev-parse", remoteMain]), "rev-parse").trim(), { label: "integrated-main" });
    if (!mainCheck.ok) return block(t, `integrated main failed: ${mainCheck.summary.slice(0, 300)}`, "owner investigates main");
    const done = await lifecycle.complete(t.n);
    if (!done.ok) return block(t, `complete refused: ${done.code} ${done.message}`, "owner completes after reconciling");
    t.finishedAt = new Date(now()).toISOString();
    t.phase = "finished";
    save(t);
    await maybeAudit(t);
    ledger(t, "finished");
    return t;
  }

  // Sol audits a sample of Luna-accepted, merged tickets (DELEGATION section 10).
  async function maybeAudit(t) {
    if (t.claimant?.role !== "controller") return;
    const accepted = state.listTickets().map((n) => state.readTicket(n)).filter((x) => x?.phase === "finished" && x.claimant?.role === "controller").length;
    if (!shouldAudit(accepted, config.audit)) return;
    const diff = must(git(repoRoot, ["diff", "--no-renames", t.baseSha, t.publishedSha]), "git diff").split("\n").slice(0, 800).join("\n");
    const bundles = allSlices(t).map((s) => readIn(state.ticketDir(t.n))(`bundle-${s.id}.md`) ?? "").join("\n\n").slice(0, 30000);
    try {
      const res = await session(t, "sol", {
        step: "audit",
        cwd: repoRoot,
        exempt: true,
        body: `Audit #${t.n} (${t.title}), merged at ${t.publishedSha}, accepted by the Luna Controller. This is accepted Luna ticket number ${accepted} in the audit sample.\n\n${bundles}\n\n--- final diff ---\n${diff}`,
        reply: '{"defect":true|false,"detail":"...","recommendation":"..."}',
      });
      t.audit = res.ok ? { defect: res.decision.defect === true, detail: String(res.decision.detail ?? "").slice(0, 500), recommendation: String(res.decision.recommendation ?? "").slice(0, 300) } : { error: `${res.code} ${res.message}` };
    } catch (error) {
      t.audit = { error: `${error.code ?? ""} ${error.message}` };
    }
    save(t);
    const file = path.join(state.home, "audits.json");
    writeJsonAtomic(file, { ...(readJson(file) ?? {}), [t.n]: { ...t.audit, at: new Date(now()).toISOString() } });
    if (t.audit.defect) log(`AUDIT DEFECT on #${t.n}: ${t.audit.detail}`);
  }

  // Clean detached checkout of a SHA, npm ci, full suite and acceptance tests.
  function checkSha(sha, { ticket = null, label = "check" } = {}) {
    if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, summary: "check-sha needs a full 40-character SHA" };
    // Under the OS temp dir: writable from inside a sandboxed Verifier session.
    const verifyRoot = path.join(os.tmpdir(), "brainstorm-delegate-verify");
    const dir = path.join(verifyRoot, `${label}-${sha.slice(0, 12)}`);
    const lines = [`check-sha ${sha}`];
    if (!fs.existsSync(dir)) {
      must(git(repoRoot, ["fetch", repo.remote]), "git fetch");
      must(git(repoRoot, ["worktree", "add", "--detach", dir, sha]), "git worktree add");
    }
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const clean = git(dir, ["status", "--porcelain"]).stdout.trim() === "";
    lines.push(`checkout: HEAD ${head === sha ? "matches" : `MISMATCH ${head}`}; tree ${clean ? "clean" : "DIRTY"}`);
    const ci = exec("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir });
    lines.push(`npm ci: exit ${ci.status}`);
    const junitDir = path.join(verifyRoot, "junit");
    fs.mkdirSync(junitDir, { recursive: true });
    const suiteOut = path.join(junitDir, `${label}-${sha.slice(0, 12)}-suite.xml`);
    const suite = exec("node", ["--test", "--test-reporter=junit", `--test-reporter-destination=${suiteOut}`, ...listMatching(dir, config.testGlob)], { cwd: dir });
    const counts = parseJunit(fs.existsSync(suiteOut) ? fs.readFileSync(suiteOut, "utf8") : "").counts;
    lines.push(`npm test (junit): ${counts.pass}/${counts.tests} pass, ${counts.fail} fail, ${counts.skipped} skipped, exit ${suite.status}`);
    let accOk = true;
    if (ticket !== null) {
      const t = state.readTicket(ticket);
      const files = t?.lockedFiles ?? [];
      const ids = (t?.cases ?? []).map((c) => c.id);
      if (files.length) {
        const accOut = path.join(junitDir, `${label}-${sha.slice(0, 12)}-acceptance.xml`);
        exec("node", ["--test", "--test-reporter=junit", `--test-reporter-destination=${accOut}`, ...files], { cwd: dir });
        const status = acceptanceStatus(parseJunit(fs.existsSync(accOut) ? fs.readFileSync(accOut, "utf8") : ""), ids);
        for (const [id, s] of Object.entries(status)) {
          const pass = s.found > 0 && s.failed === 0 && s.skipped === 0;
          accOk &&= pass;
          lines.push(`acceptance ${id}: ${pass ? "PASS" : "FAIL"}`);
        }
      } else lines.push("acceptance: none (express)");
      if (t?.baseTestCount !== undefined && counts.tests < t.baseTestCount) { accOk = false; lines.push(`test count ${counts.tests} < base ${t.baseTestCount}`); }
    }
    const ok = head === sha && clean && ci.status === 0 && suite.status === 0 && counts.fail === 0 && accOk;
    lines.push(`RESULT: ${ok ? "PASS" : "FAIL"}`);
    return { ok, summary: lines.slice(0, 30).join("\n") };
  }

  // ---- text ------------------------------------------------------------------------

  function evidenceText(t) {
    const req = t.deepseek?.requests ?? [];
    const slices = allSlices(t);
    return [
      `# Delegation evidence for #${t.n}`,
      "",
      `- Lane: ${t.lane}${t.laneDecided && t.laneDecided !== t.lane ? ` (raised from ${t.laneDecided} by a category override)` : ""}; category ${t.category}; base ${t.baseSha}; claimant ${t.claimant?.role}`,
      `- Recon quotes verified: ${t.recon ? `${t.recon.verified}/${t.recon.total}` : "n/a"}`,
      ...slices.map((s) => `- ${s.id} (${s.goal}): commit ${s.commit}; ladder ${(s.attempts ?? []).map((a) => `${a.model}/${a.effort}:${a.result}`).join(", ")}; red on base ${s.redOnBase ?? "n/a"}; acceptance ${s.lastAcceptance}; regression ${s.lastRegression}; mutants ${s.mutants ? `${s.mutants.killed}/${s.mutants.total}${s.mutants.strengthened ? " (strengthened)" : ""}` : "not run"}; pre-review ${s.preReview ? (s.preReview.findings.length ? s.preReview.findings.join(" | ") : "NONE") : "not run"}; repairs ${s.repairs ?? 0}`),
      ...(t.realProcessEvidence?.length ? [`- Sol real-process checks: ${t.realProcessEvidence.join(" | ")}`] : []),
      `- Decisions: ${(t.decisionsLog ?? []).map((d) => `${d.by} ${d.decision} (${d.slice})`).join(", ") || "none"}`,
      `- DeepSeek requests: ${req.map((r) => `${r.requestId ?? "?"} (${r.model ?? r.requested}/${r.effort}, ${r.finish})`).join("; ").slice(0, 1500) || "none"}`,
      `- Codex sessions: ${(t.codexSessions ?? []).map((s) => `${s.role}/${s.model}`).join(", ")}`,
      "",
    ].join("\n");
  }

  function prBody(t) {
    const slices = allSlices(t);
    return [
      `Delegated implementation of #${t.n} (lane: ${t.lane}; ${slices.length} slice(s)). Evidence: \`${config.evidenceDir}/${t.n}.md\`.`,
      "",
      ...slices.map((s) => `- ${s.id}: acceptance ${s.lastAcceptance}; regression ${s.lastRegression}`),
      `- Implementation: DeepSeek via the delegation harness; decisions by ${[...new Set((t.codexSessions ?? []).map((s) => s.model))].join(", ")}.`,
      "",
      "Merge only after the lifecycle review and verification name this exact SHA. Do not write closing keywords; lifecycle `complete` closes the issue.",
    ].join("\n");
  }

  function signoffText(t) {
    return [
      `# Sign-off needed: #${t.n} ${t.title}`,
      "",
      `PR: ${t.prUrl ?? t.prNumber}  Commit: ${t.publishedSha}`,
      "",
      "What changed:",
      ...allSlices(t).flatMap((s) => (s.workerNotes ?? []).map((n) => `- ${s.id}: ${n}`)),
      "",
      "Approved cases:",
      ...(t.cases ?? []).map((c) => `- ${c.id}: ${c.given ?? ""} -> ${c.expect}`),
      "",
      "To accept, comment on the issue from the owner account, naming the exact commit:",
      `Accepted: ${t.publishedSha}`,
      "",
    ].join("\n");
  }

  function ledger(t, outcome) {
    const sessions = t.codexSessions ?? [];
    const sum = (k) => sessions.reduce((a, s) => a + (s.usage?.[k] ?? 0) / (s.shared ?? 1), 0);
    const slices = allSlices(t);
    const attempts = [...slices.flatMap((s) => s.attempts ?? []), ...(isTerminal(t.phase) && t.phase !== "finished" && t.phase !== "awaiting-owner" ? t.attempts ?? [] : [])];
    appendLedger(state.ledgerFile, {
      ticket: t.n, title: t.title, category: t.category, lane: t.laneDecided ?? t.lane, final_lane: t.lane, fit: t.fit ?? "", base_sha: t.baseSha, outcome,
      slices: slices.length, attempts: attempts.length, models: [...new Set(attempts.map((a) => a.model))].join(" "),
      deepseek_usd: (t.deepseek?.usdEstimate ?? 0).toFixed(4), recon_quotes_verified: t.recon ? `${t.recon.verified}/${t.recon.total}` : "",
      mutants: slices.map((s) => (s.mutants ? `${s.mutants.killed}/${s.mutants.total}` : "-")).join(" "),
      pre_review: slices.map((s) => (s.preReview ? s.preReview.findings.length : "-")).join(" "),
      codex_sessions: sessions.length, codex_input: Math.round(sum("input")), codex_cached: Math.round(sum("cached")), codex_output: Math.round(sum("output")),
      codex_credits: sessions.reduce((a, s) => a + (s.credits ?? 0), 0).toFixed(3), sol_sessions: sessions.filter((s) => s.role === "sol").length,
      decision: (t.decisionsLog ?? []).map((d) => d.decision).join(" "), repairs: slices.reduce((a, s) => a + (s.repairs ?? 0), 0), escalated: t.escalated ? "Y" : "N",
      audited: t.audit ? (t.audit.error ? "error" : t.audit.defect ? "defect" : "clean") : "", pr: t.prUrl ?? "", merged_sha: t.publishedSha ?? "", finished_at: t.finishedAt ?? "",
    });
  }

  // Advance one ticket as far as it can go.
  async function advance(t) {
    if (!isTerminal(t.phase)) recoverScratch(t);
    const steps = {
      worktree: recon,
      recon: triageAndClaim,
      triaged: claimAsController,
      "needs-sol": solDesign,
      claimed: acceptanceTests,
      tests: (x) => implement(x),
      implemented: qualityChecks,
      checked: gateDecision,
      rpc: realProcessCheck,
      accepted: publish,
      pushed: openPr,
      published: review,
      reviewed: verify,
      verified: finish,
    };
    while (!isTerminal(t.phase)) {
      const step = steps[t.phase];
      if (!step) throw stop("BAD_PHASE", `#${t.n}: no step for phase ${t.phase}`);
      const before = JSON.stringify([t.phase, t.sliceIndex]);
      t = (await step(t)) ?? t;
      if (JSON.stringify([t.phase, t.sliceIndex]) === before) throw stop("NO_PROGRESS", `#${t.n}: step ${t.phase} made no progress`);
    }
    if (t.phase === "blocked" || t.phase === "flagged") ledger(t, t.phase);
    return t;
  }

  return { recoverScratch, intake, recon, batchTriage, triageAndClaim, claimAsController, solDesign, acceptanceTests, implement, qualityChecks, bundle, gateDecision, publish, openPr, review, verify, finish, checkSha, advance, evaluate, restoreBase };
}

// ---- filesystem helpers ---------------------------------------------------------------

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function listMatching(root, glob) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (matchesAny(r, [glob])) out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

function findFile(root, predicate, depth) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  let found = null;
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && predicate(e.name)) found = full;
    else if (e.isDirectory() && depth > 0) found = findFile(full, predicate, depth - 1) ?? found;
  }
  return found;
}

function exampleTest(root) {
  for (const name of ["test/quiz-core.test.js", "test/quiz-validation.test.js"]) {
    try { return fs.readFileSync(path.join(root, name), "utf8").split("\n").slice(0, 40).join("\n"); } catch { /* next */ }
  }
  return "";
}

function firstSection(body, title) {
  const m = new RegExp(`##\\s+${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`).exec(String(body ?? ""));
  return m ? m[1].trim().split("\n").slice(0, 6).join(" ") : "";
}

function cacheHit(t) {
  let hit = 0, total = 0;
  for (const r of t.deepseek?.requests ?? []) {
    hit += r.usage?.prompt_cache_hit_tokens ?? 0;
    total += r.usage?.prompt_tokens ?? 0;
  }
  return total ? Math.round((hit / total) * 100) : null;
}

export const _internal = { listMatching, findFile, firstSection };
