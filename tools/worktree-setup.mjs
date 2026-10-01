// Bootstrap and check a fresh git worktree (issue #6, playbook section 7).
//
//   node tools/worktree-setup.mjs [--base <commit>] [--dry-run]
//
// Run it from inside the new worktree. It reads state with read-only git
// commands, judges it with scripts/guard/worktree-checks.mjs, and only if every
// check passes runs the repository's frozen-lockfile install (`npm ci`). It never
// resets, cleans, checks out or stashes anything, and it never talks to GitHub.
// Exit codes: 0 ready, 1 a check or the install failed, 2 bad usage.
//
// This file starts git and npm, so it lives in tools/, not scripts/: the GitHub
// bypass test (test/roadmap-bypass.test.js) keeps scripts/ free of child_process.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { evaluateWorktree } from "../scripts/guard/worktree-checks.mjs";

function realExec(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" && command === "npm" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const realProbe = {
  isLink: () => {
    try { return fs.lstatSync("node_modules").isSymbolicLink(); } catch { return false; }
  },
  hasLockfile: () => fs.existsSync("package-lock.json"),
  wantedNode: () => {
    for (const file of [".nvmrc", ".node-version"]) {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim() || null;
    }
    return null;
  },
};

function parseArgs(argv) {
  const flags = { dryRun: false, base: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--base") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return { error: "--base needs a commit" };
      flags.base = value;
      i += 1;
    } else return { error: `unknown argument ${argv[i]}` };
  }
  return { flags };
}

export async function runWorktreeSetup(argv, { exec = realExec, probe = realProbe, out = (s) => console.log(s), err = (s) => console.error(s) } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`${parsed.error}\nusage: node tools/worktree-setup.mjs [--base <commit>] [--dry-run]`);
    return 2;
  }
  const { base, dryRun } = parsed.flags;
  const stdout = (command, args) => exec(command, args).stdout.trim();
  const ancestor = base ? exec("git", ["merge-base", "--is-ancestor", base, "HEAD"]).status : null;
  const facts = {
    branch: stdout("git", ["branch", "--show-current"]),
    head: stdout("git", ["rev-parse", "HEAD"]),
    clean: stdout("git", ["status", "--porcelain"]) === "",
    baseIsAncestor: ancestor === null ? null : ancestor === 0 ? true : ancestor === 1 ? false : null,
    nodeModulesIsLink: probe.isLink(),
    lockfilePresent: probe.hasLockfile(),
    nodeVersion: stdout("node", ["--version"]),
    wantedNode: probe.wantedNode(),
  };
  const result = evaluateWorktree(facts, { base });
  for (const c of result.checks) out(`${c.ok ? "PASS" : "FAIL"} ${c.id}${c.skipped ? " (skipped)" : ""}: ${c.message}`);
  if (!result.ok) {
    out("FAIL: this worktree is not ready; nothing was installed.");
    return 1;
  }
  if (dryRun) {
    out("would run: npm ci (dry run, nothing installed)");
    return 0;
  }
  const install = exec(result.install[0], result.install.slice(1));
  if (install.status !== 0) {
    out(`FAIL: npm ci failed (exit ${install.status}): ${String(install.stderr ?? "").trim().slice(0, 300)}`);
    return 1;
  }
  out("PASS: npm ci completed; this worktree has its own frozen-lockfile install.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorktreeSetup(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
