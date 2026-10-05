// Acceptance-file lock: SHA-256 per file, recorded after the red-on-base check
// and compared after every implementation attempt.

import { createHash } from "node:crypto";

export const sha256 = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

// readFile(path) -> content or null when missing
export function makeLock(paths, readFile) {
  const files = {};
  for (const filePath of [...paths].sort()) {
    const content = readFile(filePath);
    if (content === null || content === undefined) throw new Error(`cannot lock missing file ${filePath}`);
    files[filePath] = sha256(content);
  }
  return { files };
}

export function lockMismatches(lock, readFile) {
  const mismatches = [];
  for (const [filePath, hash] of Object.entries(lock?.files ?? {})) {
    const content = readFile(filePath);
    if (content === null || content === undefined) mismatches.push(`${filePath} (missing)`);
    else if (sha256(content) !== hash) mismatches.push(filePath);
  }
  return mismatches;
}
