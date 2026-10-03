// Read a secret from a private file (the DeepSeek key, the GitHub token).
// The file must be chmod 600; error messages never include its contents.

import fs from "node:fs";
import path from "node:path";

// The file named by env[envName] when set, otherwise defaultName in the delegate home.
export function secretFilePath({ env, envName, home, defaultName }) {
  return env[envName] || path.join(home, defaultName);
}

export function readPrivateFile(file, { label, code, hint = "" }) {
  const refuse = (c, message) => Object.assign(new Error(message), { code: c });
  if (!fs.existsSync(file)) throw refuse(code, `${label} not found${hint ? ` (${hint})` : ""}`);
  if ((fs.statSync(file).mode & 0o077) !== 0) throw refuse("KEY_PERMISSIONS", `${label} is readable by other users; chmod 600 it`);
  const value = fs.readFileSync(file, "utf8").trim();
  if (!value) throw refuse(code, `${label} is empty`);
  return value;
}
