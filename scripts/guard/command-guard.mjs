// Command guard (issue #6, playbook section 7): decides, from the TEXT of a shell
// command alone, whether Claude Code should be allowed to run it. Nothing here
// runs a command, touches a file or reaches the network.
//
// It is a guard, not a sandbox and not a backup. It reads commands the way a
// shell would (quotes, chains, $(...), bash -c, powershell -Command, eval, xargs,
// find -exec) and refuses a fixed list of destructive or shared-state commands
// taken from CLAUDE.md. Anything it cannot see in the command text is not covered;
// docs/roadmap/guard-coverage.md says exactly what.

import path from "node:path";

export const RULES = [
  { id: "reset-hard", summary: "git reset --hard", reason: "git reset --hard discards uncommitted work, which may belong to the user or another agent" },
  { id: "git-clean", summary: "git clean", reason: "git clean deletes untracked files, which may be someone's in-flight work" },
  { id: "force-push", summary: "force, mirror, delete or + refspec pushes", reason: "force, mirror and delete pushes rewrite or remove shared history" },
  { id: "add-all", summary: "git add -A / . / -u, git commit -a", reason: "stage explicit paths only; broad staging sweeps in work that is not yours" },
  { id: "stash", summary: "git stash (except list/show)", reason: "automatic stashing hides work; it needs an explicit request" },
  { id: "branch-force-delete", summary: "git branch -D", reason: "use git branch -d, which refuses to delete unmerged work" },
  { id: "discard-changes", summary: "broad checkout/restore, switch -f", reason: "this throws away working-tree changes wholesale" },
  { id: "worktree-force-remove", summary: "git worktree remove --force", reason: "check git status in the worktree first; a forced removal can lose untracked files" },
  { id: "deploy", summary: "wrangler deploy/publish, npm run deploy", reason: "deploys ship the working directory to production and stay with the owner" },
  { id: "supabase-write", summary: "supabase db push / db reset / migration repair / functions deploy", reason: "this mutates the production project and needs the owner's explicit approval" },
  { id: "recursive-delete", summary: "recursive deletion outside a scratch directory", reason: "recursive deletion is allowed only strictly inside a scratch directory you created" },
  { id: "unparseable", summary: "a command whose text cannot be read", reason: "the command could not be parsed, so it cannot be checked" },
];
const REASONS = Object.fromEntries(RULES.map((r) => [r.id, r.reason]));

const deny = (rule, detail) => ({ allow: false, rule, reason: `${rule}: ${REASONS[rule]}${detail ? ` (${detail})` : ""}. Ask the user if this is really needed.` });

// ---- reading the command ---------------------------------------------------

// Splits shell text into command segments of tokens, and collects the text of
// $(...) and `...` substitutions so they are checked as commands of their own.
// Returns { ok:false } for unbalanced quotes or substitutions.
function scan(input) {
  const segments = [];
  const subs = [];
  let tokens = [];
  let buf = "";
  let has = false;
  const endToken = () => { if (has) tokens.push(buf); buf = ""; has = false; };
  const endSegment = () => { endToken(); if (tokens.length > 0) segments.push(tokens); tokens = []; };

  const readParen = (from) => {
    let depth = 1;
    let quote = null;
    for (let j = from; j < input.length; j += 1) {
      const ch = input[j];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") { depth -= 1; if (depth === 0) return { inner: input.slice(from, j), end: j }; }
    }
    return null;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) return { ok: false };
      buf += input.slice(i + 1, close);
      has = true;
      i = close + 1;
    } else if (ch === '"') {
      i += 1;
      has = true;
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '"') { closed = true; i += 1; break; }
        if (c === "\\" && input[i + 1] === '"') { buf += '"'; i += 2; continue; }
        if (c === "$" && input[i + 1] === "(") {
          const sub = readParen(i + 2);
          if (!sub) return { ok: false };
          subs.push(sub.inner);
          i = sub.end + 1;
          continue;
        }
        if (c === "`") {
          const close = input.indexOf("`", i + 1);
          if (close === -1) return { ok: false };
          subs.push(input.slice(i + 1, close));
          i = close + 1;
          continue;
        }
        buf += c;
        i += 1;
      }
      if (!closed) return { ok: false };
    } else if (ch === "$" && input[i + 1] === "(") {
      const sub = readParen(i + 2);
      if (!sub) return { ok: false };
      subs.push(sub.inner);
      has = true;
      i = sub.end + 1;
    } else if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      if (close === -1) return { ok: false };
      subs.push(input.slice(i + 1, close));
      has = true;
      i = close + 1;
    } else if (ch === "\\" && i + 1 < input.length && " \t\"'\\$&|;<>()`".includes(input[i + 1])) {
      buf += input[i + 1];
      has = true;
      i += 2;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endToken();
      i += 1;
    } else if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
      endSegment();
      i += 1;
    } else if (ch === "&" || ch === "|") {
      endSegment();
      i += input[i + 1] === ch ? 2 : 1;
    } else {
      buf += ch;
      has = true;
      i += 1;
    }
  }
  endSegment();
  return { ok: true, segments, subs };
}

const KEYWORDS = new Set(["{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "!", "time"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "exec", "nohup", "nice", "env", "xargs"]);
const WRAPPER_FLAGS_WITH_VALUE = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C"]), env: new Set(["-u", "-S", "-C"]), nice: new Set(["-n"]),
  xargs: new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "-J"]), doas: new Set(["-u", "-C"]), command: new Set(), builtin: new Set(), exec: new Set(["-a"]), nohup: new Set(),
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

function programName(token) {
  let name = String(token).split(/[\\/]/).pop().toLowerCase();
  name = name.replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
  if (/^[a-z0-9._-]+@[\w.^~-]+$/.test(name)) name = name.split("@")[0]; // npx wrangler@4
  return name;
}

const isFlag = (t) => t.startsWith("-") && t.length > 1;
const shortCluster = (t) => /^-[A-Za-z]+$/.test(t);
const clusterHas = (t, letters) => shortCluster(t) && [...t.slice(1)].some((c) => letters.includes(c));
const BROAD_PATHSPEC = new Set([".", "*", ":/", ":(top)", "./"]);

// ---- scratch directories ---------------------------------------------------

const toSlashes = (p) => String(p).replace(/\\/g, "/");
const isAbsolute = (p) => /^\/|^[A-Za-z]:\//.test(p);
const canonical = (p) => {
  let out = path.posix.normalize(toSlashes(p)).replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(out)) out = out.toLowerCase(); // Windows paths are case-insensitive
  return out;
};

function insideScratch(target, ctx) {
  if (!target || /[$%~*?`{}]/.test(target)) return false;
  let p = toSlashes(target);
  if (!isAbsolute(p)) {
    if (!ctx.cwd) return false;
    p = `${toSlashes(ctx.cwd).replace(/\/+$/, "")}/${p}`;
  }
  const resolved = canonical(p);
  return ctx.scratchDirs.some((root) => resolved.startsWith(`${root}/`));
}

// ---- per-command rules -----------------------------------------------------

const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

function checkGit(args) {
  let i = 0;
  while (i < args.length && isFlag(args[i])) i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const flags = rest.filter(isFlag);
  switch (sub) {
    case "reset":
      if (rest.some((t) => t.length > 3 && "--hard".startsWith(t))) return deny("reset-hard");
      return null;
    case "clean":
      return deny("git-clean");
    case "push":
      if (rest.some((t) => t === "--mirror" || t === "--delete" || t.startsWith("--force") || t === "-f" || clusterHas(t, "fd"))) return deny("force-push");
      if (rest.some((t) => !isFlag(t) && (t.startsWith("+") || t.startsWith(":")))) return deny("force-push", "refspec forces or deletes");
      return null;
    case "add":
      if (rest.some((t) => t === "--all" || t === "--update" || clusterHas(t, "Au") || BROAD_PATHSPEC.has(t))) return deny("add-all");
      return null;
    case "commit": {
      let skip = false;
      for (const t of rest) {
        if (skip) { skip = false; continue; }
        if (t === "--all") return deny("add-all", "git commit --all");
        if (t.startsWith("--") || !shortCluster(t)) continue;
        for (const c of t.slice(1)) {
          if (c === "a") return deny("add-all", "git commit -a");
          if ("mFcCtS".includes(c)) { skip = c === t.at(-1); break; }
        }
      }
      return null;
    }
    case "stash": {
      const action = rest.find((t) => !isFlag(t));
      return action === "list" || action === "show" ? null : deny("stash");
    }
    case "branch":
      if (rest.some((t) => clusterHas(t, "D"))) return deny("branch-force-delete");
      if (rest.some((t) => t === "--delete" || clusterHas(t, "d")) && rest.some((t) => t === "--force" || clusterHas(t, "f"))) return deny("branch-force-delete");
      return null;
    case "checkout":
      if (rest.some((t) => t === "--force" || clusterHas(t, "f") || BROAD_PATHSPEC.has(t))) return deny("discard-changes");
      return null;
    case "restore": {
      const stagedOnly = flags.some((t) => t === "--staged" || clusterHas(t, "S")) && !flags.some((t) => t === "--worktree" || clusterHas(t, "W"));
      if (!stagedOnly && rest.some((t) => BROAD_PATHSPEC.has(t))) return deny("discard-changes");
      return null;
    }
    case "switch":
      if (rest.some((t) => t === "--force" || t === "--discard-changes" || clusterHas(t, "f"))) return deny("discard-changes");
      return null;
    case "worktree":
      if (rest[0] === "remove" && rest.some((t) => t === "--force" || clusterHas(t, "f"))) return deny("worktree-force-remove");
      return null;
    default:
      return null;
  }
}

function firstTwoWords(args) {
  return args.filter((t) => !isFlag(t)).slice(0, 2);
}

function hasSequence(args, sequence) {
  const words = args.filter((t) => !isFlag(t));
  for (let i = 0; i + sequence.length <= words.length; i += 1) {
    if (sequence.every((w, k) => words[i + k] === w)) return true;
  }
  return false;
}

const DEPLOY_WORDS = new Set(["deploy", "publish"]);

function checkRemoval(prog, args, ctx) {
  const cmdStyle = ["rmdir", "rd", "del", "erase"].includes(prog);
  const powershell = prog === "remove-item" || prog === "ri";
  let recursive = false;
  const targets = [];
  let afterDashes = false;
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (!afterDashes && t === "--") { afterDashes = true; continue; }
    if (cmdStyle && /^\/[A-Za-z]$/.test(t)) { if (t.toLowerCase() === "/s") recursive = true; continue; }
    if (!afterDashes && isFlag(t)) {
      if (t === "--recursive") recursive = true;
      else if (powershell) {
        if (/^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(t)) recursive = true;
        else if (/^-(?:path|literalpath|pa|lit\w*)$/i.test(t)) { targets.push(args[i + 1]); i += 1; }
        else if (/^-(?:include|exclude|filter|credential|stream)$/i.test(t)) i += 1;
      } else if (!cmdStyle && clusterHas(t, "rR")) recursive = true;
      continue;
    }
    targets.push(t);
  }
  if (!recursive) return null;
  if (targets.length === 0) return deny("recursive-delete", "no explicit target");
  const outside = targets.find((t) => !insideScratch(t, ctx));
  return outside === undefined ? null : deny("recursive-delete", `target ${JSON.stringify(outside)} is not strictly inside a scratch directory`);
}

function decodeEncodedCommand(value) {
  try {
    return Buffer.from(value, "base64").toString("utf16le");
  } catch {
    return "";
  }
}

function checkSegment(tokens, ctx, depth) {
  let t = tokens.slice();
  for (;;) {
    if (t.length === 0) return null;
    if (KEYWORDS.has(t[0]) || ENV_ASSIGNMENT.test(t[0])) { t.shift(); continue; }
    const wrapper = programName(t[0]);
    if (!WRAPPERS.has(wrapper)) break;
    t.shift();
    while (t.length > 0 && (isFlag(t[0]) || (wrapper === "env" && ENV_ASSIGNMENT.test(t[0])))) {
      const flag = t.shift();
      if (WRAPPER_FLAGS_WITH_VALUE[wrapper]?.has(flag)) t.shift();
    }
    if (wrapper === "xargs" && t.length === 0) return null;
  }
  const prog = programName(t[0]);
  const args = t.slice(1);

  if (SHELLS.has(prog)) {
    const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return at === -1 || args[at + 1] === undefined ? null : evaluate(args[at + 1], ctx, depth + 1);
  }
  if (prog === "powershell" || prog === "pwsh") {
    const encoded = args.findIndex((a) => /^-(?:e|ec|encodedcommand)$/i.test(a));
    if (encoded !== -1 && args[encoded + 1]) return evaluate(decodeEncodedCommand(args[encoded + 1]), ctx, depth + 1);
    const at = args.findIndex((a) => /^-(?:c|command)$/i.test(a));
    return at === -1 ? null : evaluate(args.slice(at + 1).join(" "), ctx, depth + 1);
  }
  if (prog === "cmd") {
    const at = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return at === -1 ? null : evaluate(args.slice(at + 1).join(" "), ctx, depth + 1);
  }
  if (prog === "eval") return evaluate(args.join(" "), ctx, depth + 1);
  if (prog === "find") {
    if (args.includes("-delete")) return deny("recursive-delete", "find -delete");
    for (let i = 0; i < args.length; i += 1) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) continue;
      const end = args.findIndex((a, k) => k > i && (a === ";" || a === "+"));
      const inner = args.slice(i + 1, end === -1 ? undefined : end);
      const verdict = checkSegment(inner, ctx, depth + 1);
      if (verdict) return verdict;
    }
    return null;
  }
  if (prog === "npx" || prog === "pnpx" || prog === "bunx") {
    const rest = args.slice();
    while (rest.length > 0 && isFlag(rest[0])) { const f = rest.shift(); if (["-p", "--package", "-c"].includes(f)) rest.shift(); }
    return checkSegment(rest, ctx, depth + 1);
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(prog)) {
    const words = args.filter((a) => !isFlag(a));
    if (["exec", "dlx", "x"].includes(words[0])) {
      const at = args.indexOf(words[0]);
      const inner = args.slice(at + 1);
      if (inner[0] === "--") inner.shift();
      return checkSegment(inner, ctx, depth + 1);
    }
    const script = ["run", "run-script", "rum", "urn"].includes(words[0]) ? words[1] : words[0];
    if (script === "deploy") return deny("deploy", `${prog} ${script}`);
    return null;
  }
  if (prog === "wrangler") return firstTwoWords(args).some((w) => DEPLOY_WORDS.has(w) || w === "rollback") ? deny("deploy", "wrangler") : null;
  if (prog === "supabase") {
    if (hasSequence(args, ["db", "push"]) || hasSequence(args, ["db", "reset"]) || hasSequence(args, ["migration", "repair"]) || hasSequence(args, ["functions", "deploy"])) {
      return deny("supabase-write");
    }
    return null;
  }
  if (prog === "git") return checkGit(args);
  if (["rm", "rmdir", "rd", "del", "erase", "remove-item", "ri"].includes(prog)) return checkRemoval(prog, args, ctx);
  return null;
}

// ---- heredocs ----------------------------------------------------------------

// Is the end of `prefix` in a position where `<<` starts a heredoc (command
// context), rather than inside quotes? Tracks '...', "..." and $(...) nesting.
function inCommandContext(prefix) {
  const stack = ["cmd"];
  for (let i = 0; i < prefix.length; i += 1) {
    const top = stack[stack.length - 1];
    const ch = prefix[i];
    if (top === "sq") { if (ch === "'") stack.pop(); continue; }
    if (top === "dq") {
      if (ch === "\\") i += 1;
      else if (ch === '"') stack.pop();
      else if (ch === "$" && prefix[i + 1] === "(") { stack.push("sub"); i += 1; }
      continue;
    }
    if (ch === "\\") i += 1;
    else if (ch === "'") stack.push("sq");
    else if (ch === '"') stack.push("dq");
    else if (ch === "$" && prefix[i + 1] === "(") { stack.push("sub"); i += 1; }
    else if (ch === ")" && top === "sub") stack.pop();
  }
  const top = stack[stack.length - 1];
  return top === "cmd" || top === "sub";
}

const SHELL_RECEIVER = /(?:^|[;&|(]\s*|\$\(\s*)(?:(?:sudo|env|command|exec|nohup)\s+)*(?:\S*[\\/])?(?:bash|sh|zsh|dash|ksh|powershell|pwsh|cmd)(?:\.exe)?(?:\s[^;&|]*)?$/i;

// Heredoc bodies are data, not shell syntax: an apostrophe in a commit message
// must not look like an unbalanced quote. Cut them out, but keep the body of one
// fed to a shell (`bash <<EOF`) so it is checked as commands. A `<<` inside quotes
// is not a heredoc, and an unterminated heredoc is refused.
function extractHeredocs(text) {
  const lines = text.split("\n");
  const kept = [];
  const heredocs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    kept.push(line);
    const marker = /<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_.-]*))/.exec(line);
    if (!marker || line[marker.index + 2] === "<" || line[marker.index - 1] === "<") continue;
    const prefix = line.slice(0, marker.index);
    if (!inCommandContext(prefix)) continue;
    const delimiter = marker[2] ?? marker[3] ?? marker[4];
    const strip = marker[1] === "-";
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].replace(/\r$/, "");
      if ((strip ? candidate.replace(/^\t+/, "") : candidate) === delimiter) { end = j; break; }
    }
    if (end === -1) return { ok: false };
    heredocs.push({ body: lines.slice(i + 1, end).join("\n"), toShell: SHELL_RECEIVER.test(prefix) });
    kept.push(lines[end]);
    i = end;
  }
  return { ok: true, text: kept.join("\n"), heredocs };
}

function evaluate(text, ctx, depth) {
  if (depth > 5) return deny("unparseable", "nested too deeply to check");
  const extracted = extractHeredocs(String(text));
  if (!extracted.ok) return deny("unparseable", "heredoc with no terminating line");
  for (const heredoc of extracted.heredocs) {
    if (!heredoc.toShell) continue;
    const verdict = evaluate(heredoc.body, ctx, depth + 1);
    if (verdict) return verdict;
  }
  const scanned = scan(extracted.text);
  if (!scanned.ok) return deny("unparseable", "unbalanced quote or substitution");
  for (const sub of scanned.subs) {
    const verdict = evaluate(sub, ctx, depth + 1);
    if (verdict) return verdict;
  }
  for (const segment of scanned.segments) {
    const verdict = checkSegment(segment, ctx, depth);
    if (verdict) return verdict;
  }
  return null;
}

// decide(command, { scratchDirs: [absolute dirs], cwd }) -> { allow: true } | { allow: false, rule, reason }
export function decide(command, { scratchDirs = [], cwd } = {}) {
  const ctx = { scratchDirs: scratchDirs.map(canonical), cwd };
  return evaluate(command, ctx, 0) ?? { allow: true };
}
