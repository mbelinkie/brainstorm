// Pure parsers for `git diff` output used by the guards.
//
//   git diff --no-renames --numstat <base>      -> parseNumstat
//   git diff --no-renames -U0 <base>            -> parseAddedLines
//   git status --porcelain=v1 -uall             -> parseUntracked (new files)

export function parseNumstat(text) {
  const files = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    const binary = added === "-" || removed === "-";
    files.push({ path: filePath, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
  }
  return files;
}

// Map of path -> array of added line texts (without the leading "+").
export function parseAddedLines(text) {
  const added = new Map();
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (current && !added.has(current)) added.set(current, []);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("@@")) continue;
    if (current && line.startsWith("+")) added.get(current).push(line.slice(1));
  }
  return added;
}

export function parseUntracked(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).replace(/^"|"$/g, ""));
}

// Combine tracked numstat with untracked new files (whose contents count as added lines).
export function summarizeChanges({ numstat = [], untracked = [], readFile = () => "" }) {
  const files = numstat.map((f) => ({ ...f }));
  const addedLines = new Map();
  for (const filePath of untracked) {
    const content = String(readFile(filePath) ?? "");
    const lines = content.length ? content.replace(/\n$/, "").split("\n") : [];
    files.push({ path: filePath, added: lines.length, removed: 0, binary: false, untracked: true });
    addedLines.set(filePath, lines);
  }
  const totals = files.reduce((acc, f) => ({ files: acc.files + 1, lines: acc.lines + f.added + f.removed }), { files: 0, lines: 0 });
  return { files, addedLines, totals };
}
