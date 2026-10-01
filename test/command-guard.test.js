import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RULES, decide } from "../scripts/guard/command-guard.mjs";
import { evaluateHookInput } from "../scripts/guard/pre-command-hook.mjs";

// Issue #6. The guard decides on command TEXT only: no test here executes any
// of the commands it feeds in. A refusal names the rule that fired.

const root = new URL("../", import.meta.url);
const SCRATCH = ["/tmp/scratch", "C:/Users/someone/AppData/Local/Temp/claude"];
const opts = { scratchDirs: SCRATCH, cwd: "/work/quiz" };

const REFUSED = {
  "reset-hard": [
    "git reset --hard", "git reset --hard HEAD~1", "git -C ../other reset --hard", "git -c core.pager=cat reset --hard origin/main",
    "/usr/bin/git reset --hard", "git.exe reset --hard", "GIT_TRACE=1 git reset --hard", "sudo git reset --hard", "env FOO=1 git reset --hard",
    "command git reset --hard", "git reset HEAD~1 --hard",
  ],
  "git-clean": ["git clean -fd", "git clean -fdx", "git clean", "git -C x clean -n"],
  "force-push": [
    "git push --force", "git push -f origin claude/x", "git push --force-with-lease", "git push origin main --force", "git push origin +main",
    "git push -fu origin x", "git push --mirror", "git push origin --delete claude/x", "git push origin :claude/x",
  ],
  "add-all": [
    "git add -A", "git add --all", "git add .", "git add -u", "git add *", "git add src docs .", "git commit -a -m x", "git commit -am x", "git commit --all -m x",
  ],
  stash: ["git stash", "git stash push", "git stash push -m x", "git stash save x", "git stash pop", "git stash apply", "git stash drop", "git stash clear"],
  "branch-force-delete": ["git branch -D claude/x", "git branch --delete --force claude/x", "git branch -d -f claude/x", "git branch -fd claude/x"],
  "discard-changes": [
    "git checkout .", "git checkout -- .", "git checkout -f", "git checkout main -- .", "git checkout :/", "git restore .", "git restore --source=HEAD~1 .",
    "git restore *", "git switch -f main", "git switch --discard-changes main",
  ],
  "worktree-force-remove": ["git worktree remove --force ../quiz-x", "git worktree remove -f ../quiz-x"],
  deploy: [
    "wrangler deploy", "npx wrangler deploy", "npx --yes wrangler@4 deploy", "wrangler publish", "npm run deploy", "npm run-script deploy", "pnpm run deploy",
    "yarn deploy", "bun run deploy", "npm exec wrangler deploy", "pnpm dlx wrangler deploy",
  ],
  "supabase-write": [
    "supabase db push", "npx supabase db push --linked", "supabase migration repair --status applied 0001", "supabase db reset", "supabase.exe db push",
  ],
  "recursive-delete": [
    "rm -rf /", "rm -rf .", "rm -rf ..", "rm -rf node_modules", "rm -r ../x", "rm -fr src", "rm -Rf src", "rm --recursive src", "rm -rf /tmp/scratchy",
    "rm -rf /tmp/scratch/../etc", "rm -rf /tmp/scratch", "rm -rf $HOME", "rm -rf ~/x", "rm -rf /tmp/scratch/*", "rm -rf",
    "Remove-Item -Recurse -Force src", "Remove-Item src -r", "Remove-Item -Path src -Recurse", "ri -Recurse src", "rmdir /s /q src", "rd /s src", "del /s x", "erase /s x",
    "find . -delete", "find . -name '*.js' -exec rm -rf {} +", "xargs rm -rf",
  ],
  wrapped: [
    'bash -c "git reset --hard"', "sh -c 'git push -f'", 'bash -lc "git clean -fd"', 'powershell -Command "Remove-Item -Recurse src"',
    "pwsh -c git reset --hard", 'cmd /c "rmdir /s /q src"', 'eval "git reset --hard"', "echo hi && git reset --hard", "ls; git clean -fd", "git status | cat && git push --force",
    "echo $(git reset --hard)", "echo `git clean -fd`", 'echo "$(git push --force)"', "(git reset --hard)", "{ git reset --hard; }", "if true; then git clean -fd; fi",
    "true\ngit reset --hard", 'bash -c "bash -c \'git reset --hard\'"',
  ],
  unparseable: ['git commit -m "unterminated', "git status 'x"],
};

const ALLOWED = [
  "git status", "git status --short --branch", "git stash list", "git stash show", "git log --oneline -5", "git diff --stat", "git diff -- .", "npm test",
  "node --test test/command-guard.test.js", "git add scripts/roadmap/x.mjs docs/y.md", "git add -- file", "git add scripts/ docs/", "git switch -c claude/x",
  "git commit -m \"fix: explain why git reset --hard is blocked\"", "git commit -m 'git push --force is blocked'", "echo 'git reset --hard'", 'echo "git clean -fd"',
  "git branch -d claude/x", "git branch -a", "git checkout claude/x", "git restore --staged path/file.js", "git push origin claude/x", "git fetch origin",
  "git reset HEAD path/file.js", "git reset --soft HEAD~1", "git merge --ff-only origin/main", "npm run prepare:deploy", "npm run build:video", "supabase migration list --linked",
  "wrangler whoami", "rm file.txt", "rm -f file.txt", "rm -rf /tmp/scratch/mut", "rm -rf '/tmp/scratch/a b'", "rm -r /tmp/scratch/x/y",
  "Remove-Item -Recurse -Force 'C:\\Users\\someone\\AppData\\Local\\Temp\\claude\\mut'", "Remove-Item file.txt", "ls -la && pwd", "grep -rn 'git reset --hard' docs",
  "gh issue view 3", "node scripts/roadmap/lifecycle.mjs inspect 6", "git commit -ma", "git -C ../quiz-x status", "cat package.json | head",
];

for (const [rule, commands] of Object.entries(REFUSED)) {
  test(`refuses (${rule}): ${commands.length} command texts, none executed`, () => {
    for (const command of commands) {
      const verdict = decide(command, opts);
      assert.equal(verdict.allow, false, `should refuse: ${JSON.stringify(command)}`);
      if (rule !== "wrapped") assert.equal(verdict.rule, rule, `${JSON.stringify(command)} fired ${verdict.rule}`);
      assert.ok(verdict.reason && verdict.reason.length > 10, "a refusal explains itself");
    }
  });
}

test("allows ordinary commands, including ones that merely MENTION a refused command", () => {
  for (const command of ALLOWED) {
    const verdict = decide(command, opts);
    assert.equal(verdict.allow, true, `should allow: ${JSON.stringify(command)} (${verdict.rule}: ${verdict.reason})`);
  }
});

test("recursive deletion is allowed only strictly inside a configured scratch directory", () => {
  assert.equal(decide("rm -rf /tmp/scratch/mut", opts).allow, true);
  assert.equal(decide("rm -rf /tmp/scratch/mut", { cwd: "/work/quiz" }).allow, false, "no scratch configured");
  assert.equal(decide("rm -rf mut", { scratchDirs: SCRATCH, cwd: "/tmp/scratch" }).allow, true, "relative target resolved against cwd inside scratch");
  assert.equal(decide("rm -rf mut", { scratchDirs: SCRATCH }).allow, false, "relative target with no cwd is unknowable");
  assert.equal(decide("rm -rf /tmp/scratch/mut /work/quiz/src", opts).allow, false, "one bad target refuses the command");
  assert.equal(decide("rm -rf C:\\Users\\someone\\AppData\\Local\\Temp\\claude\\x", opts).allow, true, "Windows paths");
});

test("every rule is declared and documented in guard-coverage.md with its uncovered cases", () => {
  const ids = new Set(RULES.map((r) => r.id));
  for (const id of Object.keys(REFUSED)) if (id !== "wrapped") assert.ok(ids.has(id), `rule ${id} is exported`);
  const doc = fs.readFileSync(new URL("docs/roadmap/guard-coverage.md", root), "utf8");
  for (const rule of RULES) assert.ok(doc.includes(`\`${rule.id}\``), `guard-coverage.md documents ${rule.id}`);
  for (const gap of ["indirect", "alias", "variable", "another tool", "human", "GUI", "not a sandbox", "not a backup"]) {
    assert.ok(doc.toLowerCase().includes(gap.toLowerCase()), `guard-coverage.md states the gap: ${gap}`);
  }
});

// ---- the Claude Code hook adapter -----------------------------------------

test("the hook denies a refused Bash or PowerShell command with the rule named, and stays silent otherwise", () => {
  const bash = evaluateHookInput({ tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: "/work/quiz" }, opts);
  assert.equal(bash.allow, false);
  assert.equal(bash.output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(bash.output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(bash.output.hookSpecificOutput.permissionDecisionReason, /reset-hard/);
  const ps = evaluateHookInput({ tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse src" } }, opts);
  assert.equal(ps.allow, false);
  const fine = evaluateHookInput({ tool_name: "Bash", tool_input: { command: "git status" } }, opts);
  assert.equal(fine.allow, true);
  assert.equal(fine.output, null);
});

test("the hook ignores other tools but fails closed on a shell call it cannot read", () => {
  assert.equal(evaluateHookInput({ tool_name: "Read", tool_input: { file_path: "x" } }, opts).allow, true);
  assert.equal(evaluateHookInput({ tool_name: "Bash", tool_input: {} }, opts).allow, false);
  assert.equal(evaluateHookInput({ tool_name: "SomeNewShellTool", tool_input: { command: "git reset --hard" } }, opts).allow, false, "an unknown tool name that carries a command is still checked");
  assert.equal(evaluateHookInput({ tool_name: "SomeNewShellTool", tool_input: { command: "git status" } }, opts).allow, true);
  assert.equal(evaluateHookInput({ tool_name: "Bash" }, opts).allow, false);
  assert.equal(evaluateHookInput(null, opts).allow, false);
  assert.equal(evaluateHookInput({ tool_name: "Bash", tool_input: { command: 42 } }, opts).allow, false);
});

test("the hook script, run as a process, answers on stdout and never runs the command it was given", () => {
  const script = fileURLToPath(new URL("scripts/guard/pre-command-hook.mjs", root));
  const run = (payload) => spawnSync(process.execPath, [script], { input: payload, encoding: "utf8" });
  const denied = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force" } }));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allowed = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "");
  const bom = run(`\uFEFF${JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } })}\r\n`);
  assert.equal(bom.stdout.trim(), "", "a byte-order mark (PowerShell pipes add one) must not turn valid input into a refusal");
  const bomDenied = run(`\uFEFF${JSON.stringify({ tool_name: "Bash", tool_input: { command: "git clean -fd" } })}`);
  assert.equal(JSON.parse(bomDenied.stdout).hookSpecificOutput.permissionDecision, "deny");
  const garbage = run("not json");
  assert.equal(JSON.parse(garbage.stdout).hookSpecificOutput.permissionDecision, "deny", "unreadable input is refused, not allowed");
});

test("the guard modules are pure: no process, file or network access", () => {
  for (const file of ["command-guard.mjs"]) {
    const text = fs.readFileSync(new URL(`scripts/guard/${file}`, root), "utf8");
    assert.ok(!/child_process|node:fs|\bfetch\s*\(|node:net|node:http/.test(text), `${file} must stay pure`);
  }
});

test("the install snippet is valid JSON, points at the hook script, and is not wired into .claude/settings.json", () => {
  const snippet = JSON.parse(fs.readFileSync(new URL("docs/roadmap/claude-settings.guard.json", root), "utf8"));
  const text = JSON.stringify(snippet);
  assert.match(text, /pre-command-hook\.mjs/);
  assert.ok(snippet.hooks.PreToolUse[0].matcher.includes("Bash"));
  assert.equal(fs.existsSync(new URL(".claude/settings.json", root)), false, "the owner approves installation; the branch must not activate the hook");
});
