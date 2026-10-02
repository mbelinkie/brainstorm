// The ticket pipeline (DELEGATION.md section 5): every step the harness takes
// for one ticket, from intake to finish. Each step reads and writes the
// ticket's private state, re-checks live state where it matters, and is safe
// to re-run after a crash.
//
// GitHub is reached only through the roadmap gate and lifecycle; git, npm and
// node through the injected exec; DeepSeek through the injected client; Codex
// through the injected session runner.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAny } from "./core/paths.mjs";
import { parseNumstat, parseAddedLines, parseUntracked, summarizeChanges } from "./core/diff.mjs";
import { parseJunit, acceptanceStatus, failsForTheRightReason } from "./core/junit.mjs";
import { checkResponse, stageArtifact } from "./core/artifacts.mjs";
import { staticGuards, testGuards, regressionOnlyGuards, classify, formatGuardLines } from "./core/guards.mjs";
import { makeLock, lockMismatches } from "./core/accept-lock.mjs";
import { runLadder, failureExcerpt } from "./core/ladder.mjs";
import { renderBundle } from "./core/bundle.mjs";
import { selectContext, verifyClaims, validateRecon, validateTriage } from "./core/recon.mjs";
import { renderWorkerPacket, renderTestAuthorPacket, renderScoutPacket, renderSessionInput } from "./core/packet.mjs";
import { overBudget, creditsFor, parseRateLimits, headroom } from "./core/codex.mjs";
import { buildMessages, chatWithLengthRetry, createSpendGuard, estimateUsd } from "./deepseek.mjs";
import { appendLedger } from "./state.mjs";
import { shellQuote } from "./exec.mjs";

const TERMINAL = new Set(["flagged", "blocked", "awaiting-owner", "finished"]);
export const isTerminal = (phase) => TERMINAL.has(phase);

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function createPipeline(ctx) {
  const { config, repoRoot, state, exec, gate, lifecycle, deepseek, runSession, now = Date.now, log = () => {}, env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = ctx;
  const repo = config.repository;
  const promptDir = ctx.promptDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
  const prompt = (name) => fs.readFileSync(path.join(promptDir, name), "utf8");

  // ---- helpers -----------------------------------------------------------

  const git = (cwd, args, opts = {}) => exec("git", args, { cwd, ...opts });
  const must = (res, what) => {
    if (res.status !== 0) throw Object.assign(new Error(`${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 400)}`), { code: "EXEC_FAILED" });
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

  async function block(t, cause, needs, phase = "blocked") {
    const res = await lifecycle.block(t.n, { cause, needs });
    t.blocked = { cause, needs, recorded: Boolean(res.ok), code: res.ok ? null : res.code };
    t.phase = phase;
    save(t);
    log(`#${t.n} ${phase}: ${cause}`);
    return t;
  }

  function batch() {
    const b = state.readBatch();
    if (!b) throw Object.assign(new Error("no batch started; run `start` first"), { code: "NO_BATCH" });
    return b;
  }

  // ---- DeepSeek calls ------------------------------------------------------

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

  // ---- Codex sessions --------------------------------------------------------

  // Plan limits pause the batch (wait for the reset) or stop it; they never block a ticket.
  async function waitForHeadroom() {
    for (;;) {
      const b = batch();
      const room = headroom({ reading: b.rateReading ?? null, headroomPercent: config.plan.headroomPercent, creditCap: config.plan.creditCap, creditsSpent: b.creditsSpent ?? 0, firstSession: (b.sessionsRun ?? 0) === 0, requireReading: config.plan.requireUsageReading !== false, nowMs: now() });
      if (room.action === "start") return room;
      if (room.action === "stop") throw Object.assign(new Error(`batch stopped: ${room.reason}`), { code: room.code });
      if (room.untilMs > b.deadlineMs) throw Object.assign(new Error(`batch stopped: plan resets after the deadline (${room.reason})`), { code: "PLAN_RESET_AFTER_DEADLINE" });
      log(`plan limit: ${room.reason}; sleeping until ${new Date(room.untilMs).toISOString()}`);
      await sleep(Math.max(0, room.untilMs - now()) + 60_000);
      // The reading is stale after a reset; the next session refreshes it.
      state.writeBatch({ ...state.readBatch(), rateReading: null, sessionsRun: 0 });
    }
  }

  async function session(t, roleName, { step, body, commands = [], reply, resumeId = null, cwd }) {
    const role = config.codex.roles[roleName];
    const perTicket = config.budgets.sessionsPerTicket[t.lane ?? "standard"] ?? 4;
    const threads = new Set((t.codexSessions ?? []).map((x) => x.threadId).filter(Boolean));
    if (!resumeId && threads.size >= perTicket) return fail("SESSION_BUDGET", `#${t.n} already used ${threads.size} Codex sessions (limit ${perTicket} for ${t.lane ?? "standard"})`);
    const room = await waitForHeadroom();
    const b = batch();
    const used = (t.codexSessions ?? []).length;
    const input = renderSessionInput({ card: role.card, step, body, commands, reply });
    const dir = path.join(state.ticketDir(t.n), "codex", `${String(used + 1).padStart(2, "0")}-${roleName}-${step.replace(/\W+/g, "-")}`);
    const workdir = cwd ?? t.worktree ?? repoRoot;
    const guardTree = Boolean(t.worktree) && workdir === t.worktree;
    const before = guardTree ? treeFingerprint(t.worktree) : null;
    const res = await runSession({ role, cwd: workdir, prompt: input, sessionDir: dir, resumeId });
    const changedTree = guardTree && treeFingerprint(t.worktree) !== before;
    const credits = creditsFor(role.model, res.usage);
    t.codexSessions = [...(t.codexSessions ?? []), { role: roleName, step, threadId: res.threadId, model: role.model, effort: role.effort, usage: res.usage, credits, onCredits: Boolean(room.onCredits), ok: res.ok }];
    const reading = readRateLimits(res.threadId);
    // An unreadable reading is stored as null on purpose: the next session then
    // stops the batch (unknown usage counts as exhausted) instead of trusting a stale one.
    state.writeBatch({ ...state.readBatch(), sessionsRun: (b.sessionsRun ?? 0) + 1, rateReading: reading, creditsSpent: (b.creditsSpent ?? 0) + (room.onCredits ? credits ?? 0 : 0) });
    save(t);
    if (changedTree) return fail("WORKTREE_CHANGED", `${roleName} session changed files in the ticket worktree; role sessions never edit files`, { session: res });
    const budget = overBudget(res.usage, config.budgets[roleName]);
    if (budget.over) return fail("CODEX_BUDGET", `${roleName} session over budget: ${budget.reason}`, { session: res });
    if (!res.ok) return fail("SESSION_FAILED", `${roleName} session failed: ${res.decisionError ?? res.errors.join("; ") ?? `exit ${res.exitCode}`}`, { session: res });
    if (!reading) log("warning: plan usage could not be read from this Codex session's log; the next session will stop the batch");
    return { ok: true, decision: res.decision, threadId: res.threadId, session: res };
  }

  function readRateLimits(threadId) {
    if (!threadId) return null;
    const home = env.CODEX_HOME || path.join(env.HOME ?? "", ".codex");
    const root = path.join(home, "sessions");
    const file = findFile(root, (name) => name.includes(threadId) && name.endsWith(".jsonl"), 5);
    return file ? parseRateLimits(fs.readFileSync(file, "utf8")) : null;
  }

  // Working-tree contents (tracked diff plus untracked files) and HEAD.
  function treeFingerprint(dir) {
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const diff = git(dir, ["diff", "HEAD"]).stdout;
    const untracked = parseUntracked(git(dir, ["status", "--porcelain=v1", "-uall"]).stdout);
    const read = readIn(dir);
    return JSON.stringify([head, diff, untracked.map((p) => [p, read(p)])]);
  }

  // ---- steps -----------------------------------------------------------------

  async function intake(n, selected) {
    const existing = state.readTicket(n);
    if (existing && !isTerminal(existing.phase)) return existing;
    const inspected = await lifecycle.inspect(n);
    if (!inspected.ok) throw Object.assign(new Error(`inspect #${n}: ${inspected.message}`), { code: inspected.code });
    const issue = await gate.read({
      query: "query DelegateIssue($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) { title body } } }",
      variables: { o: repo.owner, r: repo.name, n },
    });
    if (!issue.ok) throw Object.assign(new Error(`issue read #${n}: ${issue.message}`), { code: issue.code });
    const t = {
      n,
      title: issue.data.repository.issue.title,
      body: issue.data.repository.issue.body,
      labels: inspected.labels ?? [],
      acceptanceClass: inspected.acceptanceClass ?? selected?.acceptance ?? null,
      baseSha: selected?.baseline ?? inspected.baseline?.oid,
      phase: "intake",
      startedAt: new Date(now()).toISOString(),
    };
    save(t);
    const flagged = t.labels.filter((l) => config.fitGate.flagLabels.includes(l));
    if (flagged.length) {
      return block(t, `Gate 0: labelled ${flagged.join(", ")}; not suited to delegated coding`, "Matthew: skip (interactive Claude session), run anyway (remove the label), or split into testable coding tickets", "flagged");
    }
    const name = `${config.worktreePrefix}${n}`;
    t.branch = `${config.branchPrefix}${n}`;
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
    const ctxSel = selectContext({ files, ticketText: `${t.title}\n${t.body}`, readFile: read, excludes: config.contextExcludes, tokenCap: config.deepseek.contextTokenCap });
    const packet = renderScoutPacket({ ticket: t.n, title: t.title, body: t.body, map: ctxSel.map, files: ctxSel.chosen.map((c) => ({ path: c.path, content: read(c.path) ?? "" })) });
    let model = config.deepseek.scout.model;
    let res = await askDeepSeek(t, { model, effort: config.deepseek.scout.effort, prefixFile: "scout-prefix.md", packet, purpose: "scout" });
    let checked = res.ok ? reviewRecon(res.artifact, read) : null;
    if (!res.ok || !checked.ok || checked.unverifiedShare > 0.2) {
      model = "deepseek-v4-pro";
      res = await askDeepSeek(t, { model, effort: "low", prefixFile: "scout-prefix.md", packet, purpose: "scout-retry" });
      checked = res.ok ? reviewRecon(res.artifact, read) : null;
    }
    save(t);
    if (!res.ok) return block(t, `recon failed: ${res.code} ${res.message ?? ""}`.trim(), "re-run recon, or Sol scopes this ticket");
    if (!checked.ok) return block(t, `recon output invalid: ${checked.problems.join("; ")}`, "re-run recon, or Sol scopes this ticket");
    const r = res.artifact;
    t.recon = { model, verified: checked.verified.length, total: checked.total, unverified: checked.unverified.map((c) => c.claim), contextFiles: ctxSel.chosen.map((c) => c.path) };
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

  async function triageAndClaim(t) {
    const r = JSON.parse(fs.readFileSync(ticketPath(t, "recon.json"), "utf8"));
    const view = [
      `Ticket #${t.n}: ${t.title}`,
      `Acceptance class: ${t.acceptanceClass}; labels: ${t.labels.join(", ") || "none"}`,
      `Scout (${t.recon.model}): ${r.summary}`,
      `Work type: ${r.work_type}; testable done: ${r.testable_done} (${r.testable_reason ?? ""}); suggested lane: ${r.suggested_lane}`,
      `Risk flags: ${r.risk_flags.join(", ") || "none"}`,
      `Recon quotes verified: ${t.recon.verified}/${t.recon.total}${t.recon.unverified.length ? `; unverified claims dropped: ${t.recon.unverified.join(" | ").slice(0, 300)}` : ""}`,
      `Files to change: ${r.files_to_change.join(", ") || "none"}`,
      `Callers: ${r.callers.join(", ") || "none"}`,
      "Proposed cases:",
      ...r.proposed_cases.map((c) => `- ${c.id} (${c.kind ?? "normal"}): ${c.given} -> ${c.expect}`),
      "Open questions:",
      ...(r.open_questions.length ? r.open_questions.map((q) => `- ${q}`) : ["- none"]),
      "",
      "Issue contract:",
      t.body.slice(0, 6000),
    ].join("\n");
    const claimCmd = [
      "env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs claim", t.n,
      '--execution-id "$CODEX_THREAD_ID"', "--branch", t.branch, "--start-commit", t.baseSha,
      "--model", config.codex.roles.controller.model, "--effort medium --effective-effort high",
      "--allow-mismatch", shellQuote("Luna controls; DeepSeek implements all slices"), "--worktree", t.worktreeName,
    ].join(" ");
    const res = await session(t, "controller", {
      step: "triage-and-claim",
      body: `${view}\n\nDecide fit, lane, decisions, approved cases and write scope (globs). Then, ONLY if fit is ok and lane is express or standard, run the claim command below. If fit is flag or lane is protected, do not claim.`,
      commands: [claimCmd],
      reply: '{"n":<n>,"fit":"ok|flag","lane":"express|standard|protected","decisions":["..."],"escalate":null|"reason","cases":[{"id":"A1","kind":"normal|failure|invariant","given":"...","expect":"..."}],"scope":["globs"],"allow":[],"claimed":true|false,"claim_refusal":null|"CODE"}',
    });
    if (!res.ok) return block(t, `triage session: ${res.code} ${res.message}`, "re-run the harness after the cause is fixed");
    const tri = validateTriage({ tickets: [res.decision] }, [t.n]);
    if (!tri.ok) return block(t, `triage output invalid: ${tri.problems.join("; ")}`, "re-run triage");
    const d = res.decision;
    t.claimant = { threadId: res.threadId };
    Object.assign(t, { lane: d.lane, decisions: d.decisions ?? [], cases: d.cases ?? [], scope: d.scope ?? [], allow: d.allow ?? [], fit: d.fit });
    writePrivate(t, "decisions.json", d);
    if (d.fit === "flag") return block(t, "Gate 0: Controller flagged this ticket as not suited to delegated coding", "Matthew: skip, run anyway, or split", "flagged");
    if (d.lane === "protected") return block(t, `Protected lane${d.escalate ? `: ${d.escalate}` : ""}`, "Sol designs and claims this ticket (Sol card, Protected lane)");
    if (d.escalate) return block(t, `Controller escalated: ${d.escalate}`, "Sol decides the open question (Sol card, escalation)");
    if (!d.claimed) return block(t, `claim not made: ${d.claim_refusal ?? "unknown"}`, "inspect the claim state; release only with stopped-execution evidence");
    const inspected = await lifecycle.inspect(t.n);
    const live = inspected.ok ? inspected.claims?.live?.executionId : null;
    if (!live || live !== String(res.threadId).toLowerCase()) {
      return block(t, `claim identity mismatch: live claim ${live ?? "none"} vs session ${res.threadId}`, "reconcile the claim before any further work");
    }
    t.phase = "claimed";
    return save(t);
  }

  async function acceptanceTests(t) {
    if (t.cases.length === 0) {
      if (t.lane !== "express") return block(t, "no acceptance cases for a non-express ticket", "re-triage");
      t.testBase = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
      t.acceptanceFiles = [];
      t.baseTestCount = runSuite(t, "base-suite").counts.tests;
      t.phase = "tests";
      return save(t);
    }
    const acceptancePath = `${config.acceptanceDir}/delegate-${t.n}-acceptance.test.js`;
    const read = readIn(t.worktree);
    const example = exampleTest(t.worktree);
    const sources = (t.scope ?? []).flatMap((g) => listMatching(t.worktree, g)).slice(0, 12).map((p) => ({ path: p, content: read(p) ?? "" }));
    let problems = [];
    for (let round = 0; round < 2; round += 1) {
      const packet = renderTestAuthorPacket({ ticket: t.n, title: t.title, cases: t.cases, acceptancePath, files: sources, exampleTest: example, contract: t.body.slice(0, 6000), problems });
      const res = await askDeepSeek(t, { ...config.deepseek.testAuthor, prefixFile: "test-author-prefix.md", packet, purpose: `test-author-${round + 1}` });
      save(t);
      if (!res.ok) { problems = [`${res.code}: ${res.message ?? ""}`]; continue; }
      const staged = stageArtifact(res.artifact, { allow: [acceptancePath], readFile: read });
      if (!staged.ok) { problems = [`${staged.code}: ${staged.message}`]; continue; }
      for (const [p, content] of staged.staged) writeFile(t.worktree, p, content);
      const run = runJunit(t, [acceptancePath], `red-on-base-${round + 1}`);
      const red = failsForTheRightReason(acceptanceStatus(run.parsed, t.cases.map((c) => c.id)));
      if (red.ok) {
        t.caseMap = res.artifact.case_map ?? [];
        t.redOnBase = `${t.cases.length}/${t.cases.length} fail by assertion on base`;
        must(git(t.worktree, ["add", "--", acceptancePath]), "git add tests");
        must(git(t.worktree, ["commit", "-m", `test: acceptance cases for #${t.n}`, "-m", `Model: DeepSeek (${config.deepseek.testAuthor.model}); written by the delegation harness test author.`]), "git commit tests");
        t.testBase = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
        t.acceptanceFiles = [acceptancePath];
        t.lock = makeLock(t.acceptanceFiles, read);
        writePrivate(t, "acceptance.lock", t.lock);
        t.baseTestCount = runSuite(t, "base-suite").counts.tests;
        t.phase = "tests";
        return save(t);
      }
      problems = red.problems;
      fs.rmSync(path.join(t.worktree, acceptancePath), { force: true });
    }
    return block(t, `acceptance tests not proven red on base: ${problems.join("; ").slice(0, 300)}`, "Controller or Sol revises the cases");
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
    const files = listMatching(t.worktree, config.testGlob);
    const run = runJunit(t, files, label);
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
        const acc = runJunit(t, t.acceptanceFiles, `acceptance-${Date.now()}`);
        const status = acceptanceStatus(acc.parsed, t.cases.map((c) => c.id));
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
    const diff = git(t.worktree, ["diff", "--no-renames", t.testBase]).stdout;
    t.lastGuards = formatGuardLines(guards);
    return { outcome, guards, failure: failureExcerpt({ guards, failingTests }), diff };
  }

  function restoreBase(t) {
    const read = readIn(t.worktree);
    const facts = gatherFacts(t);
    for (const p of facts.changedPaths) {
      if (t.acceptanceFiles.includes(p) || !matchesAny(p, t.scope)) continue;
      const atBase = git(t.worktree, ["show", `${t.testBase}:${p}`]);
      if (atBase.status === 0) writeFile(t.worktree, p, atBase.stdout);
      else if (read(p) !== null) fs.rmSync(path.join(t.worktree, p), { force: true });
    }
  }

  async function implement(t, { startRung = 0, note = null } = {}) {
    const read = readIn(t.worktree);
    const guard = spendGuard();
    restoreBase(t); // every ladder run starts from the committed tests
    const result = await runLadder({
      rungs: config.ladder,
      startRung,
      note,
      deps: {
        spendCheck: guard,
        restoreBase: async () => restoreBase(t),
        callModel: async (rung, { previous, note: n }) => {
          const files = [...new Set([...(t.scope ?? []).flatMap((g) => listMatching(t.worktree, g)), ...t.acceptanceFiles])]
            .slice(0, 20)
            .map((p) => ({ path: p, content: read(p) ?? "" }));
          const packet = renderWorkerPacket({
            ticket: t.n, title: t.title, lane: t.lane, baseSha: t.testBase, runtime: `Node ${process.versions.node}, ES modules, node:test`,
            goal: firstSection(t.body, "Outcome") || t.title, contract: t.body.slice(0, 6000), decisions: t.decisions, cases: t.cases,
            scope: t.scope, allow: t.allow, acceptanceFiles: t.acceptanceFiles, files, note: n, previous,
          });
          return askDeepSeek(t, { model: rung.model, effort: rung.effort, prefixFile: "worker-prefix.md", packet, failure: previous?.failure ?? "", purpose: `implement-${rung.model}-${rung.effort}` });
        },
        apply: async (artifact) => {
          const staged = stageArtifact(artifact, { allow: t.scope, locked: t.acceptanceFiles, readFile: read });
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
    t.ladder = { outcome: result.outcome, code: result.code ?? null, message: result.message ?? null };
    if (result.outcome === "STOPPED") {
      save(t); // phase unchanged: the ladder reruns from the start on resume
      throw Object.assign(new Error(`batch stopped: ${result.code} ${result.message ?? ""}`), { code: result.code ?? "STOPPED" });
    }
    t.phase = "implemented";
    save(t);
    if (result.outcome === "PROMOTE_PROTECTED") return block(t, "the change touches protected paths", "Sol re-scopes this ticket in the Protected lane");
    if (result.outcome === "PROMOTE_LANE") return block(t, `the change exceeds the ${t.lane} lane limits`, "re-triage in a higher lane, or split the ticket");
    if (result.outcome === "SPLIT_NEEDED") return block(t, "DeepSeek output limit hit twice; the slice is too large", "split the ticket into smaller slices");
    return t;
  }

  function bundle(t) {
    const diff = git(t.worktree, ["diff", "--no-renames", t.testBase]).stdout;
    const diffStat = git(t.worktree, ["diff", "--no-renames", "--stat", t.baseSha]).stdout;
    const untracked = parseUntracked(git(t.worktree, ["status", "--porcelain=v1", "-uall"]).stdout);
    const newFiles = untracked.map((p) => `--- /dev/null\n+++ b/${p}\n${(readIn(t.worktree)(p) ?? "").split("\n").map((l) => `+${l}`).join("\n")}`).join("\n");
    const lines = t.lastGuards ?? [];
    const r = renderBundle({
      ticket: t.n, title: t.title, lane: t.lane, baseSha: t.baseSha, attempts: t.attempts ?? [],
      deepseekUsd: t.deepseek?.usdEstimate ?? null, cacheHitPercent: cacheHit(t), models: [...new Set((t.deepseek?.requests ?? []).map((q) => q.model).filter(Boolean))],
      decisions: t.decisions, cases: t.cases, caseMap: t.caseMap ?? [], guardsPassed: lines.filter((l) => l.startsWith("PASS")).length, guardsTotal: lines.length, guardLines: lines,
      acceptanceLine: t.lastAcceptance, regressionLine: t.lastRegression, redOnBaseLine: t.redOnBase ?? "n/a", reconLine: t.recon ? `${t.recon.verified}/${t.recon.total} verified` : "n/a",
      workerNotes: t.workerNotes ?? [], diff: [diff, newFiles].filter(Boolean).join("\n"), diffStat,
    });
    if (!r.ok) return r;
    writePrivate(t, "bundle.md", r.text);
    t.bundleReady = true;
    save(t);
    return { ok: true, text: r.text };
  }

  async function gateDecision(t) {
    const b = bundle(t);
    if (!b.ok) return block(t, `bundle refused: ${b.message}`, "split the ticket or escalate to Sol");
    const green = t.ladder?.outcome === "GREEN";
    const res = await session(t, "controller", {
      step: "gate",
      resumeId: t.claimant.threadId,
      body: `${green ? "The ladder finished GREEN." : `The ladder did NOT finish green (${t.ladder?.outcome}); ACCEPT is not available.`}\n\n${b.text}`,
      reply: '{"decision":"ACCEPT|REPAIR|ESCALATE|RECLAIM","note":"<=5 lines, required for REPAIR/ESCALATE/RECLAIM"}',
    });
    if (!res.ok) return block(t, `gate session: ${res.code} ${res.message}`, "re-run the harness after the cause is fixed");
    let decision = String(res.decision.decision ?? "").toUpperCase();
    const note = String(res.decision.note ?? "").split("\n").slice(0, 5).join("\n");
    if (decision === "ACCEPT" && !green) decision = "ESCALATE";
    if (decision === "REPAIR" && (t.repairs ?? 0) >= 1) decision = "ESCALATE";
    t.decisionsLog = [...(t.decisionsLog ?? []), { by: "controller", decision, note }];
    save(t);
    return applyDecision(t, decision, note, "controller");
  }

  async function applyDecision(t, decision, note, by) {
    if (decision === "ACCEPT") { t.phase = "accepted"; return save(t); }
    if (decision === "REPAIR") {
      t.repairs = (t.repairs ?? 0) + 1;
      save(t);
      await implement(t, { startRung: config.repairStartRung, note });
      if (isTerminal(t.phase)) return t;
      return gateDecision(t);
    }
    if (decision === "ESCALATE" && by === "controller") return escalate(t, note);
    if (decision === "RECLAIM" || decision === "PROTECTED" || decision === "ESCALATE") {
      return block(t, `${by} ${decision.toLowerCase()}: ${note}`.slice(0, 400), decision === "PROTECTED" ? "Sol re-scopes this ticket in the Protected lane" : "re-slice or redesign before further work");
    }
    return block(t, `unknown decision ${decision} from ${by}`, "inspect the session output");
  }

  async function escalate(t, reason) {
    t.escalated = true;
    const res = await session(t, "sol", {
      step: "escalation",
      cwd: t.worktree,
      body: `Controller's reason: ${reason}\n\n${fs.readFileSync(ticketPath(t, "bundle.md"), "utf8")}`,
      reply: '{"decision":"ACCEPT|REPAIR|RECLAIM|PROTECTED","note":"<=5 lines","reason":"..."}',
    });
    if (!res.ok) return block(t, `Sol escalation session: ${res.code} ${res.message}`, "Sol reviews this ticket interactively");
    let decision = String(res.decision.decision ?? "").toUpperCase();
    if (decision === "ACCEPT" && t.ladder?.outcome !== "GREEN") decision = "RECLAIM";
    if (decision === "REPAIR" && (t.repairs ?? 0) >= 2) decision = "RECLAIM";
    t.decisionsLog = [...(t.decisionsLog ?? []), { by: "sol", decision, note: res.decision.note ?? "" }];
    save(t);
    if (decision === "REPAIR") {
      t.repairs = (t.repairs ?? 0) + 1;
      save(t);
      await implement(t, { startRung: config.repairStartRung, note: String(res.decision.note ?? "") });
      if (isTerminal(t.phase)) return t;
      bundle(t);
      if (t.ladder?.outcome !== "GREEN") return block(t, "Sol-directed repair did not reach green", "Sol takes this ticket in the Protected lane");
      return applyDecision(t, "ACCEPT", "", "sol");
    }
    return applyDecision(t, decision, String(res.decision.note ?? ""), "sol");
  }

  function publish(t) {
    if (t.publishedSha) return t;
    const facts = gatherFacts(t);
    const paths = facts.changedPaths.filter((p) => !t.acceptanceFiles.includes(p));
    const models = [...new Set((t.attempts ?? []).filter((a) => a.result === "GREEN").map((a) => `${a.model}/${a.effort}`))];
    if (paths.length) {
      must(git(t.worktree, ["add", "--", ...paths]), "git add");
      must(git(t.worktree, ["commit", "-m", `feat: ${t.title} (#${t.n})`, "-m", `Model: DeepSeek (${models.join(", ") || "unknown"}); applied and checked by the delegation harness.`]), "git commit");
    }
    const evidencePath = `${config.evidenceDir}/${t.n}.md`;
    writeFile(t.worktree, evidencePath, evidenceText(t));
    must(git(t.worktree, ["add", "--", evidencePath]), "git add evidence");
    must(git(t.worktree, ["commit", "-m", `docs: delegation evidence for #${t.n}`]), "git commit evidence");
    t.publishedSha = must(git(t.worktree, ["rev-parse", "HEAD"]), "rev-parse").trim();
    must(git(t.worktree, ["push", "-u", repo.remote, t.branch]), "git push");
    t.phase = "pushed";
    return save(t);
  }

  async function openPr(t) {
    if (!t.prNumber) {
      // Re-read first: an earlier POST may have succeeded with an uncertain answer.
      const existing = await gate.rest({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${repo.owner}:${t.branch}`)}&state=all` });
      if (!existing.ok) throw Object.assign(new Error(`read PRs: ${existing.message}`), { code: existing.code });
      const found = Array.isArray(existing.data) ? existing.data.find((pr) => pr.head?.ref === t.branch) : null;
      if (found) {
        t.prNumber = found.number;
        t.prUrl = found.html_url;
      } else {
        const res = await gate.rest({
          method: "POST",
          path: `/repos/${repo.owner}/${repo.name}/pulls`,
          body: { title: `${t.title} (#${t.n})`, head: t.branch, base: repo.integrationBranch, body: prBody(t) },
        });
        if (!res.ok) throw Object.assign(new Error(`open PR: ${res.message} (re-run: the harness re-reads before retrying)`), { code: res.code });
        t.prNumber = res.data?.number;
        t.prUrl = res.data?.html_url;
      }
    }
    t.phase = "published";
    return save(t);
  }

  async function review(t) {
    const cmd = [
      "env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs review", t.n,
      '--execution-id "$CODEX_THREAD_ID"', "--commit", t.publishedSha,
      "--commands", shellQuote(`harness: ${t.lastRegression}; acceptance ${t.lastAcceptance}; guards ${(t.lastGuards ?? []).filter((l) => l.startsWith("PASS")).length}/${(t.lastGuards ?? []).length} PASS at ${t.publishedSha}`),
      "--exclusions", shellQuote("mutant check and pre-review not run (harness build step 7)"),
      "--outstanding", shellQuote(t.acceptanceClass === "Producer" ? "owner acceptance of this exact commit" : "independent verification of this exact commit"),
      "--branch", t.branch,
    ].join(" ");
    const res = await session(t, "controller", {
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
    const verifyCmd = [
      "env -u CODEX_SESSION_ID node scripts/roadmap/lifecycle.mjs verify", t.n,
      '--execution-id "$CODEX_THREAD_ID"', "--commit", t.publishedSha,
      '--checks "$CHECKS"',
    ].join(" ");
    const res = await session(t, "verifier", {
      step: "verify",
      cwd: repoRoot,
      body: [`Run the first command. Only if its summary ends with RESULT: PASS and matches the evidence below, run the second command with CHECKS filled from the summary.`, `Ticket #${t.n}, published SHA ${t.publishedSha}.`, `Bundle base test count: ${t.baseTestCount}.`, `Approved cases: ${t.cases.map((c) => c.id).join(", ") || "none (express)"}.`, `Bundle evidence: regression ${t.lastRegression}; acceptance ${t.lastAcceptance}.`].join("\n"),
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
    if (t.acceptanceClass === "Producer") {
      writePrivate(t, "signoff.md", signoffText(t));
      t.phase = "awaiting-owner";
      save(t);
      ledger(t, "awaiting-owner");
      return t;
    }
    if (t.acceptanceClass !== "Automated") return block(t, `acceptance class ${t.acceptanceClass} is not finished by the harness`, "owner handles acceptance");
    const pr = await gate.rest({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls/${t.prNumber}` });
    if (!pr.ok) throw Object.assign(new Error(`read PR: ${pr.message}`), { code: pr.code });
    if (pr.data?.head?.sha !== t.publishedSha) return block(t, `PR head ${pr.data?.head?.sha} is not the verified SHA ${t.publishedSha}`, "owner reconciles the PR before merging");
    if (!pr.data?.merged) {
      // A merge commit preserves the verified SHA (no squash, no rebase).
      const merged = await gate.rest({
        method: "PUT",
        path: `/repos/${repo.owner}/${repo.name}/pulls/${t.prNumber}/merge`,
        body: { merge_method: "merge", sha: t.publishedSha },
      });
      if (!merged.ok) return block(t, `merge refused: ${merged.message}`, "owner merges after checking the PR");
    }
    must(git(repoRoot, ["fetch", repo.remote, repo.integrationBranch]), "git fetch");
    const remoteMain = `${repo.remote}/${repo.integrationBranch}`;
    if (git(repoRoot, ["merge-base", "--is-ancestor", t.publishedSha, remoteMain]).status !== 0) {
      return block(t, "verified SHA is not reachable from main after merge", "owner checks the merge");
    }
    const mainCheck = checkSha(must(git(repoRoot, ["rev-parse", remoteMain]), "rev-parse").trim(), { label: "integrated-main" });
    if (!mainCheck.ok) return block(t, `integrated main failed: ${mainCheck.summary.slice(0, 300)}`, "owner investigates main");
    const done = await lifecycle.complete(t.n);
    if (!done.ok) return block(t, `complete refused: ${done.code} ${done.message}`, "owner completes after reconciling");
    t.phase = "finished";
    t.finishedAt = new Date(now()).toISOString();
    save(t);
    ledger(t, "finished");
    return t;
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
    const suiteFiles = listMatching(dir, config.testGlob);
    const suite = exec("node", ["--test", "--test-reporter=junit", `--test-reporter-destination=${suiteOut}`, ...suiteFiles], { cwd: dir });
    const counts = parseJunit(fs.existsSync(suiteOut) ? fs.readFileSync(suiteOut, "utf8") : "").counts;
    lines.push(`npm test (junit): ${counts.pass}/${counts.tests} pass, ${counts.fail} fail, ${counts.skipped} skipped, exit ${suite.status}`);
    let accOk = true;
    if (ticket !== null) {
      const t = state.readTicket(ticket);
      const files = t?.acceptanceFiles ?? [];
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

  // ---- text ------------------------------------------------------------------

  function evidenceText(t) {
    const req = t.deepseek?.requests ?? [];
    return [
      `# Delegation evidence for #${t.n}`,
      "",
      `- Lane: ${t.lane}; base ${t.baseSha}; tests committed at ${t.testBase}`,
      `- DeepSeek requests: ${req.map((r) => `${r.requestId ?? "?"} (${r.model ?? r.requested}/${r.effort}, ${r.finish})`).join("; ").slice(0, 900) || "none"}`,
      `- Ladder: ${(t.attempts ?? []).map((a) => `${a.model}/${a.effort}:${a.result}`).join(", ")}`,
      `- Recon quotes verified: ${t.recon ? `${t.recon.verified}/${t.recon.total}` : "n/a"}`,
      `- Red on base: ${t.redOnBase ?? "n/a"}`,
      `- Guards: ${(t.lastGuards ?? []).filter((l) => l.startsWith("PASS")).length}/${(t.lastGuards ?? []).length} PASS`,
      `- Acceptance: ${t.lastAcceptance ?? "n/a"}`,
      `- Regression: ${t.lastRegression ?? "n/a"}`,
      `- Decisions: ${(t.decisionsLog ?? []).map((d) => `${d.by} ${d.decision}`).join(", ") || "none"}; repairs ${t.repairs ?? 0}`,
      `- Codex sessions: ${(t.codexSessions ?? []).map((s) => `${s.role}/${s.model}`).join(", ")}`,
      "- Not run: mutant check and pre-review (harness build step 7).",
      "",
    ].join("\n");
  }

  function prBody(t) {
    return [
      `Delegated implementation of #${t.n} (lane: ${t.lane}). Evidence: \`${config.evidenceDir}/${t.n}.md\`.`,
      "",
      `- Acceptance: ${t.lastAcceptance ?? "n/a"}`,
      `- Regression: ${t.lastRegression ?? "n/a"}`,
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
      ...(t.workerNotes ?? []).map((n) => `- ${n}`),
      "",
      "Approved cases:",
      ...t.cases.map((c) => `- ${c.id}: ${c.given ?? ""} -> ${c.expect}`),
      "",
      "To accept, comment on the issue from the owner account, naming the exact commit:",
      `Accepted: ${t.publishedSha}`,
      "",
    ].join("\n");
  }

  function ledger(t, outcome) {
    const sessions = t.codexSessions ?? [];
    const sum = (k) => sessions.reduce((a, s) => a + (s.usage?.[k] ?? 0), 0);
    appendLedger(state.ledgerFile, {
      ticket: t.n, title: t.title, lane: t.lane, final_lane: t.lane, fit: t.fit ?? "", base_sha: t.baseSha, outcome,
      attempts: (t.attempts ?? []).length, models: [...new Set((t.attempts ?? []).map((a) => a.model))].join(" "),
      deepseek_usd: (t.deepseek?.usdEstimate ?? 0).toFixed(4), recon_quotes_verified: t.recon ? `${t.recon.verified}/${t.recon.total}` : "",
      codex_sessions: sessions.length, codex_input: sum("input"), codex_cached: sum("cached"), codex_output: sum("output"),
      codex_credits: sessions.reduce((a, s) => a + (s.credits ?? 0), 0).toFixed(3), sol_sessions: sessions.filter((s) => s.role === "sol").length,
      decision: (t.decisionsLog ?? []).map((d) => d.decision).join(" "), repairs: t.repairs ?? 0, escalated: t.escalated ? "Y" : "N",
      pr: t.prUrl ?? "", merged_sha: t.publishedSha ?? "", finished_at: t.finishedAt ?? "",
    });
  }

  // Advance one ticket as far as it can go.
  async function advance(t) {
    const steps = {
      worktree: recon,
      recon: triageAndClaim,
      claimed: acceptanceTests,
      tests: (x) => implement(x),
      implemented: gateDecision,
      accepted: publish,
      pushed: openPr,
      published: review,
      reviewed: verify,
      verified: finish,
    };
    while (!isTerminal(t.phase)) {
      const step = steps[t.phase];
      if (!step) throw Object.assign(new Error(`#${t.n}: no step for phase ${t.phase}`), { code: "BAD_PHASE" });
      const before = t.phase;
      t = (await step(t)) ?? t;
      if (t.phase === before) throw Object.assign(new Error(`#${t.n}: step ${before} made no progress`), { code: "NO_PROGRESS" });
    }
    if (t.phase === "blocked" || t.phase === "flagged") ledger(t, t.phase);
    return t;
  }

  return { intake, recon, triageAndClaim, acceptanceTests, implement, bundle, gateDecision, publish, openPr, review, verify, finish, checkSha, advance, evaluate, restoreBase };
}

// ---- filesystem helpers ------------------------------------------------------

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
  const reqs = t.deepseek?.requests ?? [];
  let hit = 0, total = 0;
  for (const r of reqs) {
    hit += r.usage?.prompt_cache_hit_tokens ?? 0;
    total += r.usage?.prompt_tokens ?? 0;
  }
  return total ? Math.round((hit / total) * 100) : null;
}

export const _internal = { listMatching, findFile, firstSection };
