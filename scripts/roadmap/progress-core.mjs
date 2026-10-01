// Pure counting and rendering for the read-only progress view (issue #5, playbook
// section 6). No I/O and no GitHub access: progress.mjs fetches, this file only
// turns what was fetched into a snapshot model and text.
//
// Counting rules (stated in every report):
//   - Draft items and pull requests are not issues; they are counted apart.
//   - Issues labeled `setup-test` are test fixtures, never production work.
//   - Issues labeled `goal` or `parent`, or titled "GOAL: ...", group work; they are not executable work.
//   - Inbox items are placeholders with unknown scope; shown, not in the denominator.
//   - Everything else is executable. Done / Remaining use that denominator.

const STATUS_ORDER = ["Inbox", "Backlog", "Blocked", "Ready", "In progress", "In review", "Done"];
const SIZE_ORDER = ["Small", "Medium", "Large", "Unknown"];
const NO_ROUTING = "no routing labels";

// A goal groups work: labeled goal/parent, or titled like "[PB] GOAL: ...".
const isGoal = (labels, title) => labels.includes("goal") || labels.includes("parent") || /^(?:\[[^\]]*\]\s*)?GOAL:/i.test(String(title ?? ""));

const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

function routingOf(labels) {
  const model = labels.find((l) => l.startsWith("model:"));
  const effort = labels.find((l) => l.startsWith("effort:"));
  return model || effort ? `${model ?? "model:?"} / ${effort ?? "effort:?"}` : NO_ROUTING;
}

export function buildProgress(items, { nowMs, fetchedAtMs, complete, partialReason = "", blocked = {}, reused = false, notes = [] } = {}) {
  const byStatus = {};
  const byWorkstream = {};
  const sizes = Object.fromEntries(SIZE_ORDER.map((s) => [s, 0]));
  const routing = {};
  const model = {
    snapshotAt: new Date(fetchedAtMs).toISOString(),
    ageSec: Math.max(0, Math.round((nowMs - fetchedAtMs) / 1000)),
    reused, complete, partialReason, notes: [...notes],
    counts: { executable: 0, done: 0, remaining: 0, inbox: 0, setupTest: 0, goals: 0, nonIssue: 0 },
    inbox: [], setupTest: [], goals: [], remainingList: [], blocked: [],
  };

  for (const item of items ?? []) {
    const content = item.content;
    if (!content || content.__typename !== "Issue") { model.counts.nonIssue += 1; continue; }
    const labels = (content.labels?.nodes ?? []).map((l) => l.name);
    const ref = { number: content.number, title: content.title, url: content.url, repo: content.repository?.nameWithOwner ?? "" };
    const status = item.status?.name ?? "(none)";
    if (labels.includes("setup-test")) { model.counts.setupTest += 1; model.setupTest.push({ ...ref, status }); continue; }
    if (isGoal(labels, content.title)) { model.counts.goals += 1; model.goals.push({ ...ref, status }); continue; }

    const size = item.size?.name ?? "Unknown";
    count(byStatus, status);
    count(byWorkstream, item.workstream?.name ?? "(none)");
    sizes[size] = (sizes[size] ?? 0) + 1;
    if (status === "Inbox") { model.counts.inbox += 1; model.inbox.push({ ...ref, size }); continue; }

    model.counts.executable += 1;
    count(routing, routingOf(labels));
    if (status === "Done") { model.counts.done += 1; continue; }
    model.counts.remaining += 1;
    model.remainingList.push({ ...ref, status, size, workstream: item.workstream?.name ?? "(none)", routing: routingOf(labels) });
    if (status === "Blocked") model.blocked.push({ ...ref, cause: blocked[content.number] ?? null });
  }

  const ordered = (map, order) => Object.fromEntries([...order.filter((k) => k in map), ...Object.keys(map).filter((k) => !order.includes(k)).sort()].map((k) => [k, map[k]]));
  model.byStatus = ordered(byStatus, STATUS_ORDER);
  model.byWorkstream = ordered(byWorkstream, []);
  model.sizes = sizes;
  model.routing = routing;
  return model;
}

const link = (i) => `[#${i.number}](${i.url})`;
const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (head, rows) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const entries = (map) => Object.entries(map).map(([k, v]) => [k, String(v)]);

export function renderMarkdown(model) {
  const c = model.counts;
  const lines = [
    "# Brainstorm Roadmap progress",
    "",
    `**Snapshot:** ${model.snapshotAt} (age ${model.ageSec}s; ${model.reused ? "reused from an earlier read" : "fetched live"})`,
  ];
  if (!model.complete) lines.push("", `> **PARTIAL.** ${model.partialReason || "the fetch did not finish"}. The totals below cover only what was fetched and are not the whole board.`);
  for (const note of model.notes) lines.push("", `> Note: ${note}`);
  lines.push(
    "",
    `**Done ${c.done} of ${c.executable} executable issues** · Remaining ${c.remaining} · Inbox placeholders ${c.inbox} (not in the denominator)`,
    "",
    "## By status", "", table(["Status", "Issues"], entries(model.byStatus)),
    "", "## By workstream", "", table(["Workstream", "Issues"], entries(model.byWorkstream)),
    "", "## Size", "", table(["Size", "Issues"], entries(model.sizes)),
    "", "## Routing (executable issues)", "", table(["Routing", "Issues"], entries(model.routing)),
    "", "## Blocked", "",
    model.blocked.length === 0 ? "None." : model.blocked.map((b) => `- ${link(b)} ${b.title}: ${b.cause ?? "no block record found"}`).join("\n"),
    "", "## Remaining work", "",
    model.remainingList.length === 0 ? "None." : table(["Issue", "Title", "Status", "Size", "Workstream"], model.remainingList.map((i) => [link(i), i.title, i.status, i.size, i.workstream])),
    "", "## Inbox placeholders (scope unknown, not executable)", "",
    model.inbox.length === 0 ? "None." : model.inbox.map((i) => `- ${link(i)} ${i.title} (size ${i.size})`).join("\n"),
  );
  if (model.goals.length > 0) lines.push("", "## Goals and parents (not counted as work)", "", model.goals.map((i) => `- ${link(i)} ${i.title}`).join("\n"));
  lines.push(
    "", "## Excluded setup-test issues", "",
    model.setupTest.length === 0 ? "None." : model.setupTest.map((i) => `- ${link(i)} ${i.title} (${i.status})`).join("\n"),
    "", `Other items not counted: ${c.nonIssue} draft or non-issue.`,
    "", "_Issue counts are not an estimate of effort or a delivery date._", "",
  );
  return lines.join("\n");
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// A local page, no scripts and no external resources.
export function renderHtml(model) {
  const c = model.counts;
  const list = (items, render) => (items.length === 0 ? "<p>None.</p>" : `<ul>${items.map((i) => `<li>${render(i)}</li>`).join("")}</ul>`);
  const a = (i) => `<a href="${escapeHtml(i.url)}">#${i.number}</a> ${escapeHtml(i.title)}`;
  const tbl = (map) => `<table>${Object.entries(map).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join("")}</table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brainstorm Roadmap progress</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:56rem;margin:0 auto;padding:1rem}table{border-collapse:collapse}td{border:1px solid #8884;padding:.2rem .6rem}.partial{background:#fc03;padding:.5rem;border-radius:.3rem}</style>
</head><body>
<h1>Brainstorm Roadmap progress</h1>
<p>Snapshot ${escapeHtml(model.snapshotAt)} (age ${model.ageSec}s; ${model.reused ? "reused from an earlier read" : "fetched live"})</p>
${model.complete ? "" : `<p class="partial"><strong>PARTIAL.</strong> ${escapeHtml(model.partialReason || "the fetch did not finish")}. Totals cover only what was fetched.</p>`}
${model.notes.map((n) => `<p>Note: ${escapeHtml(n)}</p>`).join("")}
<p><strong>Done ${c.done} of ${c.executable} executable issues</strong> &middot; Remaining ${c.remaining} &middot; Inbox placeholders ${c.inbox} (not in the denominator)</p>
<h2>By status</h2>${tbl(model.byStatus)}
<h2>By workstream</h2>${tbl(model.byWorkstream)}
<h2>Size</h2>${tbl(model.sizes)}
<h2>Routing (executable issues)</h2>${tbl(model.routing)}
<h2>Blocked</h2>${list(model.blocked, (b) => `${a(b)}: ${escapeHtml(b.cause ?? "no block record found")}`)}
<h2>Remaining work</h2>${list(model.remainingList, (i) => `${a(i)} (${escapeHtml(i.status)}, ${escapeHtml(i.size)}, ${escapeHtml(i.workstream)})`)}
<h2>Inbox placeholders (scope unknown, not executable)</h2>${list(model.inbox, a)}
<h2>Excluded setup-test issues</h2>${list(model.setupTest, a)}
<p>Other items not counted: ${c.nonIssue} draft or non-issue.</p>
<p><em>Issue counts are not an estimate of effort or a delivery date.</em></p>
</body></html>
`;
}
