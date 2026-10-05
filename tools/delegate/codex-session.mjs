// Launch one Codex session (new or resumed) and collect its evidence.
// The harness waits on the process; no model ever waits on another.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildExecArgs, childEnv, parseEvents, parseDecision } from "./core/codex.mjs";

export function runProcess({ command, args, cwd, input, env, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnImpl(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    const done = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error });
    };
    child.on("error", (e) => done(null, String(e.message)));
    child.on("close", (code) => done(code));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// role: { model, effort }; returns { ok, threadId, usage, decision, exitCode, errors, files }
export async function runCodexSession({ command = "codex", role, cwd, prompt, sessionDir, resumeId = null, sandbox, extraConfig, schemaFile = null, timeoutMs = 1_800_000, env = process.env, githubToken = null, spawnImpl }) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const outputFile = path.join(sessionDir, "last-message.txt");
  const eventsFile = path.join(sessionDir, "events.jsonl");
  const args = buildExecArgs({ model: role.model, effort: role.effort, sandbox, extraConfig, cwd, outputFile, schemaFile, resumeId });
  fs.writeFileSync(path.join(sessionDir, "prompt.md"), prompt);
  fs.writeFileSync(path.join(sessionDir, "args.json"), JSON.stringify(args, null, 2));
  const result = await runProcess({ command, args, cwd, input: prompt, env: childEnv(env, { githubToken }), timeoutMs, spawnImpl });
  fs.writeFileSync(eventsFile, result.stdout);
  if (result.stderr) fs.writeFileSync(path.join(sessionDir, "stderr.txt"), result.stderr);
  const events = parseEvents(result.stdout);
  const last = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  const decision = parseDecision(last);
  const threadId = events.threadId ?? resumeId;
  const ok = result.code === 0 && !events.failed && decision.ok;
  return {
    ok,
    exitCode: result.code,
    threadId,
    usage: events.usage,
    turns: events.turns,
    errors: [...events.errors, ...(result.error ? [result.error] : [])],
    decision: decision.ok ? decision.value : null,
    decisionError: decision.ok ? null : decision.code,
    model: role.model,
    effort: role.effort,
  };
}
