import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPrivateFile } from "../tools/delegate/core/secret-file.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "delegate-secret-"));

test("private file: missing is refused with the caller's code and hint", () => {
  const file = path.join(tmp(), "github.token");
  assert.throws(() => readPrivateFile(file, { label: "GitHub token file", code: "NO_GITHUB_TOKEN", hint: "create it" }),
    (e) => e.code === "NO_GITHUB_TOKEN" && /GitHub token file not found/.test(e.message) && /create it/.test(e.message));
});

test("private file: readable by group or others is refused, and the message never holds the contents", () => {
  const file = path.join(tmp(), "github.token");
  fs.writeFileSync(file, "sentinel-secret\n");
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPrivateFile(file, { label: "GitHub token file", code: "NO_GITHUB_TOKEN" }),
    (e) => e.code === "KEY_PERMISSIONS" && /chmod 600/.test(e.message) && !/sentinel-secret/.test(e.message));
});

test("private file: chmod 600 is read and trimmed; an empty file is refused", () => {
  const dir = tmp();
  const file = path.join(dir, "github.token");
  fs.writeFileSync(file, "  sentinel-secret\n");
  fs.chmodSync(file, 0o600);
  assert.equal(readPrivateFile(file, { label: "GitHub token file", code: "NO_GITHUB_TOKEN" }), "sentinel-secret");
  const empty = path.join(dir, "empty.token");
  fs.writeFileSync(empty, "\n");
  fs.chmodSync(empty, 0o600);
  assert.throws(() => readPrivateFile(empty, { label: "GitHub token file", code: "NO_GITHUB_TOKEN" }), (e) => e.code === "NO_GITHUB_TOKEN" && /empty/.test(e.message));
});
