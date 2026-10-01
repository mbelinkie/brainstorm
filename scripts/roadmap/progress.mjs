// Read-only progress view of the Brainstorm Roadmap Project (issue #5, playbook
// section 6).
//
//   node scripts/roadmap/progress.mjs [--html <file>] [--max-age <seconds>] [--fresh] [--snapshot <file>]
//
// Every read goes through the shared gate (gate.readAll / gate.read); this file
// has no write path and no other transport. Exit codes: 0 complete, 1 refused by
// the gate (nothing written), 2 bad usage, 3 partial snapshot.
//
// A snapshot of the last complete read is kept in the OS temp directory and
// reused inside --max-age (default 60s) with its timestamp shown, so repeated
// refreshes do not spend quota. --fresh always reads. A partial snapshot is
// never reused.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGate } from "./gate.mjs";
import { createGhTransport } from "./github-transport.mjs";
import { latestBlockCause } from "./lifecycle-core.mjs";
import { buildProgress, renderHtml, renderMarkdown } from "./progress-core.mjs";

const FIELD = (alias, name) => `${alias}: fieldValueByName(name: "${name}") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;
const MAX_BLOCKED_LOOKUPS = 20;

function itemsQuery(ownerField) {
  return `query ProgressItems($login: String!, $number: Int!, $first: Int!, $cursor: String) {
  ${ownerField}(login: $login) { projectV2(number: $number) { items(first: $first, after: $cursor) {
    nodes {
      id
      ${FIELD("status", "Status")}
      ${FIELD("size", "Size")}
      ${FIELD("workstream", "Workstream")}
      ${FIELD("acceptance", "Acceptance")}
      content { __typename ... on Issue { number title state url repository { nameWithOwner } labels(first: 50) { nodes { name } pageInfo { hasNextPage } } } }
    }
    pageInfo { hasNextPage endCursor }
  } } }
}`;
}

// Numbers come from the fetched board and are integers; owner and name come from config.
function blockedQuery(owner, name, numbers) {
  const parts = numbers.map((n, i) => `b${i}: issue(number: ${n}) { comments(last: 20) { nodes { body author { login } } pageInfo { hasPreviousPage } } }`);
  return `query ProgressBlocked { repository(owner: "${owner}", name: "${name}") { ${parts.join(" ")} } }`;
}

const VALUE_FLAGS = new Set(["html", "max-age", "snapshot"]);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `unexpected argument ${arg}` };
    const name = arg.slice(2);
    if (name === "fresh") { flags.fresh = true; continue; }
    if (!VALUE_FLAGS.has(name)) return { error: `unknown flag ${arg}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
    flags[name] = value;
    i += 1;
  }
  if (flags["max-age"] !== undefined && !(Number(flags["max-age"]) >= 0)) return { error: "--max-age must be a number of seconds" };
  return { flags };
}

const USAGE = "usage: node scripts/roadmap/progress.mjs [--html <file>] [--max-age <seconds>] [--fresh] [--snapshot <file>]";

export async function runProgress(argv, { gate, config, now = Date.now, fsApi = fs, out = (s) => console.log(s), err = (s) => console.error(s), snapshotPath } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) { err(`${parsed.error}\n${USAGE}`); return 2; }
  const { flags } = parsed;
  const maxAgeMs = (flags["max-age"] === undefined ? 60 : Number(flags["max-age"])) * 1000;
  const snapFile = flags.snapshot ?? snapshotPath ?? path.join(os.tmpdir(), "brainstorm-roadmap-progress.json");

  let snapshot = null;
  let reused = false;
  if (!flags.fresh && maxAgeMs > 0 && fsApi.existsSync(snapFile)) {
    try {
      const saved = JSON.parse(fsApi.readFileSync(snapFile, "utf8"));
      if (saved.complete === true && Number.isFinite(saved.fetchedAtMs) && now() - saved.fetchedAtMs <= maxAgeMs) {
        snapshot = saved;
        reused = true;
      }
    } catch {
      // an unreadable snapshot is simply not reused
    }
  }

  if (!snapshot) {
    const { owner, name } = config.repository;
    const ownerField = config.project.ownerType === "organization" ? "organization" : "user";
    const result = await gate.readAll({
      query: itemsQuery(ownerField), variables: { login: config.project.owner, number: config.project.number },
      connectionPath: [ownerField, "projectV2", "items"],
    });
    let items;
    let complete = true;
    let partialReason = "";
    if (result.ok) {
      items = result.nodes;
    } else if (result.code === "PAGINATION_BOUND" && Array.isArray(result.partial)) {
      items = result.partial;
      complete = false;
      partialReason = result.message;
    } else {
      err(`REFUSED ${result.code}: ${result.message}${result.retryAt ? ` (next allowed attempt ${result.retryAt})` : ""}`);
      return 1;
    }

    const thisRepo = `${owner}/${name}`;
    const blockedNumbers = items
      .filter((it) => it.status?.name === "Blocked" && it.content?.__typename === "Issue" && it.content.repository?.nameWithOwner === thisRepo)
      .map((it) => it.content.number);
    const blocked = {};
    const notes = [];
    if (blockedNumbers.length > 0) {
      const wanted = blockedNumbers.slice(0, MAX_BLOCKED_LOOKUPS);
      const read = await gate.read({ query: blockedQuery(owner, name, wanted) });
      if (read.ok) {
        wanted.forEach((number, i) => {
          const comments = read.data.repository?.[`b${i}`]?.comments?.nodes ?? [];
          const cause = latestBlockCause(comments, number);
          if (cause) blocked[number] = cause;
        });
      } else {
        notes.push(`block reasons were not fetched (${read.code})`);
      }
      if (blockedNumbers.length > wanted.length) notes.push(`block reasons were looked up for the first ${wanted.length} of ${blockedNumbers.length} blocked issues`);
    }
    snapshot = { fetchedAtMs: now(), complete, partialReason, items, blocked, notes };
    fsApi.writeFileSync(snapFile, JSON.stringify(snapshot));
  }

  const model = buildProgress(snapshot.items, {
    nowMs: now(), fetchedAtMs: snapshot.fetchedAtMs, complete: snapshot.complete, partialReason: snapshot.partialReason,
    blocked: snapshot.blocked, reused, notes: snapshot.notes,
  });
  if (flags.html) fsApi.writeFileSync(flags.html, renderHtml(model));
  out(renderMarkdown(model));
  return snapshot.complete ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(new URL("../../docs/roadmap/config.json", import.meta.url), "utf8"));
  const gate = createGate({ transport: createGhTransport() });
  runProgress(process.argv.slice(2), { gate, config }).then((code) => { process.exitCode = code; });
}
