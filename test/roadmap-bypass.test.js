import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ALLOWED_TRANSPORT_FILES, findBypasses, findTransports, listScriptFiles } from "../scripts/roadmap/bypass-check.mjs";

// Every repo-owned reader and writer must go through the roadmap gate. These
// tests scan scripts/ so a new file that shells out to `gh`, hits GitHub's API
// host, or imports child_process fails the build instead of silently bypassing
// the budget protection.

const root = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");

const files = () => listScriptFiles(root);

test("the real scripts/ tree has no bypass of the gate", () => {
  const scanned = files();
  assert.ok(scanned.length >= 5, "should scan the roadmap modules");
  assert.deepEqual(findBypasses(scanned), []);
});

test("the bypass check fails on seeded violations of every rule", () => {
  const seeded = [
    { path: "scripts/evil-spawn.mjs", text: 'import { spawnSync } from "node:child_process";\nspawnSync("gh", ["api", "x"]);' },
    { path: "scripts/evil-shell.mjs", text: 'execSync("gh api graphql -f query=x")' },
    { path: "scripts/evil-host.mjs", text: 'const base = "https://api.github.com/repos";' },
    { path: "scripts/evil-graphql.mjs", text: 'await fetch("https://github.com/graphql", {})' },
    { path: "scripts/evil-cjs.cjs", text: 'const cp = require("node:child_process");' },
  ];
  const violations = findBypasses(seeded);
  for (const file of seeded) assert.ok(violations.some((v) => v.file === file.path), `${file.path} should be flagged`);
  assert.ok(violations.some((v) => v.rule === "starts-gh"));
  assert.ok(violations.some((v) => v.rule === "shell-gh"));
  assert.ok(violations.some((v) => v.rule === "api-host"));
  assert.ok(violations.some((v) => v.rule === "graphql-endpoint"));
  assert.ok(violations.some((v) => v.rule === "child-process"));
});

test("only the transport file may contain a direct transport, and it is exempt", () => {
  const transport = { path: ALLOWED_TRANSPORT_FILES[0], text: 'import { spawnSync } from "node:child_process"; spawnSync("gh", []);' };
  assert.deepEqual(findBypasses([transport]), []);
  assert.deepEqual(findTransports([transport]), [ALLOWED_TRANSPORT_FILES[0]]);
});

test("the transport inventory lists exactly the transports that exist", () => {
  const inventory = fs.readFileSync(new URL("docs/roadmap/transport-inventory.md", new URL("../", import.meta.url)), "utf8");
  const section = inventory.split(/^## /m).find((part) => part.startsWith("Transports in the repo"));
  assert.ok(section, "inventory needs a 'Transports in the repo' section");
  const listed = [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]).sort();
  const actual = findTransports(files()).sort();
  assert.deepEqual(listed, actual);
  assert.deepEqual(listed, [...ALLOWED_TRANSPORT_FILES].sort());
});

test("the delegation harness reaches GitHub only through the gate", () => {
  // tools/delegate starts git, npm, node and codex (so child_process is allowed
  // there), but it must never start gh or call GitHub's API directly.
  const harness = listScriptFiles(root, "tools/delegate");
  assert.ok(harness.length >= 5, "should scan the harness modules");
  const violations = findBypasses(harness).filter((v) => v.rule !== "child-process");
  assert.deepEqual(violations, []);
});
