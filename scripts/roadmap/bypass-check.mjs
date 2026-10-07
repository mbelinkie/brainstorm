// Detects code under scripts/ that reaches GitHub without going through the gate.
//
// Only the transport file may start `gh`, import child_process, or name GitHub's
// API host. Everything else must call the gate. Regular expressions here are
// written so this file does not match its own patterns.

import fs from "node:fs";
import path from "node:path";

export const ALLOWED_TRANSPORT_FILES = ["scripts/roadmap/github-transport.mjs"];
export const VETTED_BACKUP_RUNNER_FILES = ["scripts/backup/run-command.mjs"];

const PATTERNS = [
  { id: "starts-gh", re: /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*[`"']gh(?:\.exe)?[`"']/ },
  { id: "shell-gh", re: /\b(?:exec|execSync)\s*\(\s*[`"']\s*gh\s/ },
  { id: "api-host", re: /api\.github\.com/ },
  { id: "graphql-endpoint", re: /github\.com\/graphql/ },
  { id: "child-process", re: /from\s+["']node:child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)/ },
  { id: "fetch-github", re: /fetch\s*\([^)]*github/i },
];

const toPosix = (value) => value.split(path.sep).join("/");

// files: [{ path: "scripts/x.mjs", text: "..." }]
export function findBypasses(files, allowed = ALLOWED_TRANSPORT_FILES) {
  const violations = [];
  for (const file of files) {
    if (allowed.includes(file.path)) continue;
    for (const { id, re } of PATTERNS) {
      if (VETTED_BACKUP_RUNNER_FILES.includes(file.path) && id === "child-process") {
        continue;
      }
      if (re.test(file.text)) violations.push({ file: file.path, rule: id });
    }
  }
  return violations;
}

// Files that DO contain a direct transport (so the inventory can be checked).
export function findTransports(files) {
  return files
    .filter((file) => PATTERNS.some(({ id, re }) => (id === "starts-gh" || id === "child-process") && re.test(file.text)))
    .map((file) => file.path);
}

export function listScriptFiles(root, dir = "scripts") {
  const out = [];
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return out;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = toPosix(path.join(dir, entry.name));
    if (entry.isDirectory()) out.push(...listScriptFiles(root, relative));
    else if (/\.(?:mjs|js|cjs|sh|ps1|cmd|bat)$/.test(entry.name)) {
      out.push({ path: relative, text: fs.readFileSync(path.join(root, relative), "utf8") });
    }
  }
  return out;
}
