import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluateWorktree } from "../scripts/guard/worktree-checks.mjs";
import { runWorktreeSetup } from "../tools/worktree-setup.mjs";

// Issue #6, worktree bootstrap. A fake exec stands in for git and npm: nothing
// here installs anything or touches a real repository.

const root = new URL("../", import.meta.url);
const BASE = "271a47d5d2651faa05d577e2e1a269e0cdaec984";
const goodFacts = () => ({
  branch: "claude/x", head: "a".repeat(40), clean: true, baseIsAncestor: true, nodeModulesIsLink: false, lockfilePresent: true,
  nodeVersion: "v24.19.0", wantedNode: null,
});

test("a clean worktree on a feature branch from the expected base passes every check", () => {
  const result = evaluateWorktree(goodFacts(), { base: BASE });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.filter((c) => !c.ok), []);
  assert.deepEqual(result.install, ["npm", "ci"], "the frozen-lockfile install, never npm install");
});

test("each unsafe condition fails its own check", () => {
  const cases = [
    [{ branch: "main" }, "branch-not-integration"],
    [{ branch: "" }, "branch-not-integration"],
    [{ clean: false }, "tree-clean"],
    [{ baseIsAncestor: false }, "base-reachable"],
    [{ baseIsAncestor: null }, "base-reachable"],
    [{ nodeModulesIsLink: true }, "node-modules-not-shared"],
    [{ lockfilePresent: false }, "lockfile-present"],
    [{ wantedNode: "v22", nodeVersion: "v24.19.0" }, "node-version"],
  ];
  for (const [change, id] of cases) {
    const result = evaluateWorktree({ ...goodFacts(), ...change }, { base: BASE });
    assert.equal(result.ok, false, id);
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.id), [id], id);
    assert.equal(result.install, null, "no install is planned when a check fails");
  }
});

test("without --base the base check is skipped, not passed silently", () => {
  const result = evaluateWorktree(goodFacts(), { base: null });
  assert.equal(result.checks.find((c) => c.id === "base-reachable").skipped, true);
  assert.equal(result.ok, true);
});

function fakeExec({ branch = "claude/x", dirty = "", ancestor = 0, link = false, lock = true } = {}) {
  const calls = [];
  return {
    calls,
    exec(command, args) {
      calls.push([command, ...args]);
      const key = `${command} ${args.join(" ")}`;
      if (key === "git branch --show-current") return { status: 0, stdout: `${branch}\n` };
      if (key === "git rev-parse HEAD") return { status: 0, stdout: `${"b".repeat(40)}\n` };
      if (key === "git status --porcelain") return { status: 0, stdout: dirty };
      if (/^git merge-base --is-ancestor /.test(key)) return { status: ancestor, stdout: "" };
      if (key === "node --version") return { status: 0, stdout: "v24.19.0\n" };
      if (command === "npm" && args[0] === "ci") return { status: 0, stdout: "added 10 packages\n" };
      throw new Error(`unexpected command ${key}`);
    },
    probe: { isLink: () => link, hasLockfile: () => lock, wantedNode: () => null },
  };
}

test("the runner reads state with read-only git, then runs npm ci exactly once", async () => {
  const f = fakeExec();
  const out = [];
  const code = await runWorktreeSetup(["--base", BASE], { exec: f.exec, probe: f.probe, out: (s) => out.push(s), err: (s) => out.push(s) });
  assert.equal(code, 0);
  const commands = f.calls.map((c) => c.join(" "));
  assert.equal(commands.filter((c) => c === "npm ci").length, 1);
  assert.ok(commands.indexOf("npm ci") > commands.indexOf("git status --porcelain"), "checks come before the install");
  for (const c of commands) assert.ok(!/npm install|reset|clean|checkout|stash|restore|rm /.test(c), `forbidden command ${c}`);
  assert.match(out.join("\n"), /PASS/);
});

test("a failing check stops before any install and exits 1", async () => {
  for (const options of [{ branch: "main" }, { dirty: " M app.js\n" }, { ancestor: 1 }, { link: true }, { lock: false }]) {
    const f = fakeExec(options);
    const out = [];
    const code = await runWorktreeSetup(["--base", BASE], { exec: f.exec, probe: f.probe, out: (s) => out.push(s), err: (s) => out.push(s) });
    assert.equal(code, 1, JSON.stringify(options));
    assert.ok(!f.calls.some((c) => c[0] === "npm"), "no install after a failed check");
    assert.match(out.join("\n"), /FAIL/);
  }
});

test("--dry-run reports the plan and installs nothing; bad usage exits 2", async () => {
  const f = fakeExec();
  const out = [];
  assert.equal(await runWorktreeSetup(["--dry-run"], { exec: f.exec, probe: f.probe, out: (s) => out.push(s), err: (s) => out.push(s) }), 0);
  assert.ok(!f.calls.some((c) => c[0] === "npm"));
  assert.match(out.join("\n"), /would run: npm ci/);
  assert.equal(await runWorktreeSetup(["--base"], { exec: f.exec, probe: f.probe, out() {}, err() {} }), 2);
  assert.equal(await runWorktreeSetup(["--wat"], { exec: f.exec, probe: f.probe, out() {}, err() {} }), 2);
});

test("a failing npm ci is reported as a failure, not a pass", async () => {
  const f = fakeExec();
  const exec = (command, args) => (command === "npm" ? { status: 1, stdout: "", stderr: "lockfile out of sync" } : f.exec(command, args));
  const out = [];
  const code = await runWorktreeSetup([], { exec, probe: f.probe, out: (s) => out.push(s), err: (s) => out.push(s) });
  assert.equal(code, 1);
  assert.match(out.join("\n"), /npm ci failed/);
});

test("the runner lives outside scripts/ so the GitHub bypass check stays strict, and the pure checks stay pure", () => {
  const checks = fs.readFileSync(new URL("scripts/guard/worktree-checks.mjs", root), "utf8");
  assert.ok(!/child_process|node:fs/.test(checks));
  const runner = fs.readFileSync(new URL("tools/worktree-setup.mjs", root), "utf8");
  assert.ok(!/api\.github\.com|\bgh\b\s*[,"']/.test(runner), "the runner never talks to GitHub");
});
