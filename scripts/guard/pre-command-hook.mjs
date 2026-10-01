// Claude Code PreToolUse hook adapter for the command guard (issue #6).
//
// Claude Code runs this before each Bash or PowerShell tool call, passing the call
// as JSON on stdin. A refused command is answered with a deny decision on stdout;
// an allowed command produces no output. A shell call this hook cannot read is
// refused, not allowed. Other tools are not this guard's business.
//
// This only does anything once the owner installs it (see
// docs/roadmap/claude-settings.guard.json). It never runs the command it was given.

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decide } from "./command-guard.mjs";

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const denial = (reason) => ({
  allow: false,
  reason,
  output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } },
});

export function defaultScratchDirs(env = process.env) {
  const extra = String(env.GUARD_SCRATCH_DIRS ?? "").split(path.delimiter).filter(Boolean);
  return [os.tmpdir(), ...extra];
}

export function evaluateHookInput(input, { scratchDirs = defaultScratchDirs(), cwd } = {}) {
  if (!input || typeof input !== "object") return denial("command guard: the hook input could not be read, so the command is refused");
  if (!SHELL_TOOLS.has(input.tool_name)) return { allow: true, output: null };
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") {
    return denial("command guard: the shell call had no readable command, so it is refused");
  }
  const verdict = decide(command, { scratchDirs, cwd: input.cwd ?? cwd });
  return verdict.allow ? { allow: true, output: null } : denial(`command guard (${verdict.rule}): ${verdict.reason}`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    result = evaluateHookInput(JSON.parse(await readStdin()));
  } catch {
    result = denial("command guard: the hook input was not valid JSON, so the command is refused");
  }
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
}
