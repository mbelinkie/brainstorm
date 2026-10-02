// Pure path helpers for the delegation harness: glob matching and path safety.
// No dependencies; globs support `**` (any depth, including none), `*` (within
// one segment), `?` (one character) and literal text. Paths are POSIX-style and
// repository-relative.

const cache = new Map();

export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const re = new RegExp(`${out}$`);
  cache.set(glob, re);
  return re;
}

export function matchesAny(filePath, globs = []) {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

// A repository-relative path that cannot escape the worktree.
export function isSafeRelativePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 400) return false;
  if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath) || filePath.includes("\\")) return false;
  if (filePath.includes("\0")) return false;
  return filePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
