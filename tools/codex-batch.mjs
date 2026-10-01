import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGate } from "../scripts/roadmap/gate.mjs";
import { createGhTransport } from "../scripts/roadmap/github-transport.mjs";
import { createLifecycle } from "../scripts/roadmap/lifecycle.mjs";
import { assessIssueContract, isFullCommitSha, ISSUE_RANGE, sortIssues } from "./batch-core.mjs";

const CONFIG_PATH = new URL("../docs/roadmap/config.json", import.meta.url);

const PROJECT_ITEM = `id
  project { number owner { ... on User { login } ... on Organization { login } } }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  acceptance: fieldValueByName(name: "Acceptance") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;

function scanQuery() {
  const issues = [];
  for (let number = ISSUE_RANGE.min; number <= ISSUE_RANGE.max; number += 1) {
    issues.push(`i${number}: issue(number: ${number}) {
      number state body
      projectItems(first: 20) { nodes { ${PROJECT_ITEM} } pageInfo { hasNextPage } }
    }`);
  }
  return `query BatchPlanScan($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { ${issues.join("\n")} }
  }`;
}

const fail = (code, message) => Object.assign(new Error(message), { code });

async function readIssueDetails({ config, gate }) {
  const result = await gate.read({
    query: scanQuery(),
    variables: { owner: config.repository.owner, name: config.repository.name },
  });
  if (!result.ok) throw fail(result.code, result.message);

  const repository = result.data?.repository;
  if (!repository) throw fail("SCAN_INCOMPLETE", "the issue scan returned no repository");

  const issues = new Map();
  for (let number = ISSUE_RANGE.min; number <= ISSUE_RANGE.max; number += 1) {
    const node = repository[`i${number}`];
    if (!node || node.number !== number || typeof node.body !== "string") {
      throw fail("SCAN_INCOMPLETE", `issue #${number} is missing or has no readable contract body`);
    }
    if (!Array.isArray(node.projectItems?.nodes) || node.projectItems.pageInfo?.hasNextPage !== false) {
      throw fail("SCAN_INCOMPLETE", `issue #${number} has incomplete Project item pagination`);
    }
    const matchingItems = node.projectItems.nodes.filter(
      (item) => item.project?.number === config.project.number && item.project?.owner?.login === config.project.owner,
    );
    if (matchingItems.length > 1) throw fail("SCAN_AMBIGUOUS", `issue #${number} has multiple items on the configured Project`);
    const item = matchingItems[0] ?? null;
    issues.set(number, {
      body: node.body,
      state: node.state,
      itemId: item?.id ?? null,
      status: item?.status?.name ?? null,
      acceptance: item?.acceptance?.name ?? null,
      priority: item?.priority?.name ?? null,
    });
  }
  return issues;
}

export function createBatchPlanner({ config, gate, lifecycle } = {}) {
  if (!config || !gate || !lifecycle) throw new TypeError("createBatchPlanner needs config, gate, and lifecycle");

  async function plan() {
    const details = await readIssueDetails({ config, gate });
    const inspected = [];

    for (let number = ISSUE_RANGE.min; number <= ISSUE_RANGE.max; number += 1) {
      const result = await lifecycle.inspect(number);
      if (!result.ok) throw fail(result.code, `inspect #${number}: ${result.message}`);
      if (result.issue?.number !== number || result.claimHistoryComplete !== true) {
        throw fail("INSPECTION_INCOMPLETE", `issue #${number} is missing or its comment history is incomplete`);
      }

      const detail = details.get(number);
      if (result.issue.state !== detail.state || result.boardItemId !== detail.itemId || result.status !== detail.status) {
        throw fail("STALE_SCAN", `issue #${number} changed while the planner was scanning; re-run the dry run`);
      }

      inspected.push({
        number,
        title: result.issue.title,
        state: result.issue.state,
        status: result.status,
        acceptance: result.acceptanceClass,
        priority: detail.priority,
        labels: result.labels,
        liveClaim: result.claims?.live ?? null,
        baseline: result.baseline?.oid ?? null,
        blockers: result.blockers,
        contract: assessIssueContract(detail.body),
        isGoal: /goal/i.test(result.issue.title ?? "") || result.labels.includes("goal"),
        routing: result.routing,
      });
    }

    const skipped = [];
    const candidates = [];
    for (const issue of inspected) {
      const reason = (code) => skipped.push({ number: issue.number, code });
      if (issue.isGoal || issue.state !== "OPEN" || issue.status === "Done") continue;
      if (!["Ready", "Backlog", "Blocked"].includes(issue.status)) continue;
      if (!Object.hasOwn(config.fields.Priority.options, issue.priority)) {
        throw fail("PRIORITY_UNKNOWN", `issue #${issue.number} has no recognized Project priority`);
      }
      if (issue.liveClaim) { reason("CLAIM_HELD"); continue; }
      if (issue.acceptance === "External") { reason("EXTERNAL_ACCEPTANCE"); continue; }
      if (!issue.contract.allowed) {
        reason(issue.contract.code);
        continue;
      }
      if (issue.blockers.length > 0) {
        skipped.push({ number: issue.number, code: "READY_BLOCKED", blockers: issue.blockers.map((blocker) => blocker.code) });
        continue;
      }
      if (!isFullCommitSha(issue.baseline)) { reason("BASELINE_SHA_UNKNOWN"); continue; }
      candidates.push(issue);
    }

    const selectedIssues = [];
    const promotionCandidates = [];
    for (const issue of sortIssues(candidates)) {
      const result = await lifecycle.ready(issue.number, { dryRun: true });
      if (!result.ok) {
        if (["NOT_READY", "ISSUE_CLOSED", "NOT_ON_BOARD", "STATUS_NOT_PROMOTABLE"].includes(result.code)) {
          skipped.push({ number: issue.number, code: result.code, blockers: result.blockers?.map((blocker) => blocker.code) ?? [] });
          continue;
        }
        throw fail(result.code, `ready --dry-run #${issue.number}: ${result.message}`);
      }
      if (result.op !== "ready" || result.dryRun !== true) {
        throw fail("DRY_RUN_UNCONFIRMED", `lifecycle did not confirm a read-only ready check for #${issue.number}`);
      }
      if (result.wouldSet !== "Ready" || result.status !== issue.status || result.changed !== (issue.status !== "Ready")) {
        throw fail("DRY_RUN_MISMATCH", `lifecycle ready dry-run did not match the scanned status of #${issue.number}`);
      }
      const summary = {
        number: issue.number,
        title: issue.title,
        priority: issue.priority,
        model: issue.routing.profile,
        modelId: config.routing.profiles[issue.routing.profile]?.modelId ?? null,
        effort: issue.routing.effort,
        baseline: issue.baseline,
        acceptance: issue.acceptance,
        mergeGate: issue.acceptance === "Producer" ? "owner acceptance after review" : "independent verification or owner acceptance",
      };
      if (issue.status === "Ready") selectedIssues.push(summary);
      else promotionCandidates.push({ ...summary, status: issue.status });
    }

    return {
      ok: true,
      op: "plan",
      dryRun: true,
      issueRange: [ISSUE_RANGE.min, ISSUE_RANGE.max],
      scanned: inspected.length,
      selected: selectedIssues[0] ?? null,
      promotionCandidates,
      skipped,
    };
  }

  return { plan };
}

export function parseCommand(args) {
  const legacy = args.find((arg) => ["--sole-dispatcher", "--resume", "--issues"].includes(arg.split("=", 1)[0]));
  if (legacy) throw fail("LEGACY_FLAG_DISABLED", `${legacy.split("=", 1)[0]} is retired; this command is read-only`);
  if (args.length === 1 && args[0] === "--help") return "help";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  throw fail("USAGE", "only --dry-run planning and --help are supported");
}

export function helpText() {
  return [
    "Usage: node tools/codex-batch.mjs --dry-run",
    "       node tools/codex-batch.mjs --help",
    "",
    "Scans issues #13–44 and reports the highest-priority Ready ticket plus eligible promotion candidates.",
    "This planner is read-only. Legacy execution and resume flags are refused.",
  ].join("\n");
}

export async function runCli(args = process.argv.slice(2), { output = console.log, error = console.error, makeContext } = {}) {
  let command;
  try {
    command = parseCommand(args);
  } catch (caught) {
    error(`REFUSED ${caught.code}: ${caught.message}`);
    return 2;
  }

  if (command === "help") {
    output(helpText());
    return 0;
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const context = makeContext ? makeContext(config) : (() => {
      const gate = createGate({ transport: createGhTransport() });
      return { gate, lifecycle: createLifecycle({ gate, config }) };
    })();
    const result = await createBatchPlanner({ config, ...context }).plan();
    output(JSON.stringify(result, null, 2));
    return 0;
  } catch (caught) {
    error(`REFUSED ${caught.code ?? "PLANNING_FAILED"}: ${caught.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli();
}
