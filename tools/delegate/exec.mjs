// Synchronous process runner for git, npm and node. Lives in tools/ (not
// scripts/) because it starts processes; it never starts `gh` and never talks
// to GitHub: GitHub goes through scripts/roadmap/gate.mjs.

import { spawnSync } from "node:child_process";

export function realExec(command, args, { cwd, input, env, timeoutMs = 900_000 } = {}) {
  if (command === "gh") throw new Error("the harness never starts gh; use the roadmap gate");
  // A suite started from inside another `node --test` run would otherwise
  // inherit NODE_TEST_CONTEXT and report to its parent instead of writing JUnit.
  const childEnv = { ...(env ?? process.env) };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd,
    input,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    shell: process.platform === "win32" && command === "npm",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ? String(result.error.message) : null };
}

// POSIX single-quote a value for a bash command a role session will run.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
