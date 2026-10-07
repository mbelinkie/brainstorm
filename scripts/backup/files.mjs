import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MANIFEST_NAME = 'MANIFEST.json';
const SIDECAR_NAME = 'MANIFEST.sha256';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function isManifestPath(rel) {
  return rel === MANIFEST_NAME || rel === SIDECAR_NAME;
}

function safeErrorPath(rel) {
  if (typeof rel !== 'string') return undefined;
  return scanSecrets(rel) ? undefined : rel;
}

function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes(String.fromCharCode(92))) return false;
  if (p.includes(String.fromCharCode(0))) return false;
  if (p.startsWith('/')) return false;
  const normalized = path.posix.normalize(p);
  if (normalized !== p) return false;
  const parts = p.split('/');
  return !parts.some((part) => part === '' || part === '.' || part === '..');
}

export function scanSecrets(input) {
  let s;
  if (Buffer.isBuffer(input)) {
    s = input.toString('latin1');
  } else if (input instanceof Uint8Array) {
    s = Buffer.from(input).toString('latin1');
  } else if (typeof input === 'string') {
    s = input;
  } else {
    s = String(input);
  }

  const patterns = [
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{10,}/,
    /sb_secret_[A-Za-z0-9]{10,}/,
  ];
  if (patterns.some((re) => re.test(s))) return true;

  const jwtRegex = /[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+/g;
  let match;
  while ((match = jwtRegex.exec(s)) !== null) {
    const parts = match[0].split('.');
    if (parts.length !== 3) continue;
    try {
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4 !== 0) payload += '=';
      const json = Buffer.from(payload, 'base64').toString('utf8');
      const obj = JSON.parse(json);
      if (obj && obj.role === 'service_role') return true;
    } catch {
      // not a valid service-role JWT
    }
  }
  return false;
}

async function canonicalizeProposedPath(p) {
  const abs = path.resolve(p);
  let current = abs;
  while (true) {
    try {
      const real = await fs.realpath(current);
      if (current === abs) return real;
      const rel = path.relative(current, abs);
      return path.join(real, rel);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return abs;
      current = parent;
    }
  }
}

function isPathContained(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function assertNoSymlinkComponents(p) {
  const abs = path.resolve(p);
  const parsed = path.parse(abs);
  let current = parsed.root;
  const parts = abs.slice(current.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        throw new Error('Path contains a symbolic link');
      }
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
  }
}

export async function assertOutsideRepo(out, repoRoot) {
  const absOut = path.resolve(out);
  const absRepo = path.resolve(repoRoot);
  if (isPathContained(absRepo, absOut)) {
    throw new Error(`Output path must be outside repository: ${absOut}`);
  }
  const realRepo = await fs.realpath(absRepo);
  const realOut = await canonicalizeProposedPath(absOut);
  if (isPathContained(realRepo, realOut)) {
    throw new Error(`Output path must be outside repository: ${absOut}`);
  }
  return realOut;
}

export async function inventoryOriginals(originalsDir, options = {}) {
  const root = path.resolve(originalsDir);
  await assertNoSymlinkComponents(root);

  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Originals root invalid: ${safeErrorPath(originalsDir) ?? 'path'}`);
  }

  const results = [];

  async function walk(dir, relBase) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) {
        const shown = safeErrorPath(rel);
        throw new Error(shown ? `Symlink not allowed: ${shown}` : 'Symlink not allowed');
      }
      if (st.isDirectory()) {
        await walk(abs, rel);
      } else if (st.isFile()) {
        const bytes = await fs.readFile(abs);
        results.push({
          path: toPosix(rel),
          size: bytes.length,
          sha256: sha256(bytes),
          copied: false,
        });
      } else {
        const shown = safeErrorPath(rel);
        throw new Error(shown ? `Unsupported entry: ${shown}` : 'Unsupported entry');
      }
    }
  }

  await walk(root, '');
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (options.copyTo) {
    const copyRoot = path.resolve(options.copyTo);
    await assertNoSymlinkComponents(copyRoot);

    const planned = results.map((item) => {
      const parts = item.path.split('/');
      const dest = path.join(copyRoot, ...parts);
      return { item, parts, dest };
    });

    for (const plan of planned) {
      await assertNoSymlinkComponents(plan.dest);
    }

    await fs.mkdir(copyRoot, { recursive: true });
    for (const plan of planned) {
      const { item, parts, dest } = plan;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(root, ...parts), dest);
      item.copied = true;
    }
  }

  return results;
}

function sanitizeSecretsDeep(value) {
  if (typeof value === 'string') {
    return scanSecrets(value) ? '[redacted]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretsDeep(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (scanSecrets(key)) continue;
      out[key] = sanitizeSecretsDeep(val);
    }
    return out;
  }
  return value;
}

function computeOverallStatus(steps, integrityFailed) {
  if (integrityFailed) return 'failed';
  for (const step of Object.values(steps)) {
    if (step && step.required === true && step.status !== 'ok') return 'failed';
  }
  return 'ok';
}

async function collectRegularFiles(root) {
  const result = [];
  let hadSecretDir = false;
  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (isManifestPath(rel)) continue;
      if (entry.isDirectory()) {
        if (scanSecrets(rel)) {
          hadSecretDir = true;
          await fs.rm(abs, { recursive: true, force: true });
          continue;
        }
        await walk(abs, rel);
      } else {
        result.push({ absPath: abs, relPosix: rel });
      }
    }
  }
  await walk(root, '');
  return { files: result, hadSecretDir };
}

export async function writeManifest(dir, metadata) {
  const root = path.resolve(dir);
  await assertNoSymlinkComponents(root);

  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    rootStat = null;
  }
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw new Error(`Invalid output directory: ${safeErrorPath(root) ?? 'path'}`);
  }

  if (!rootStat) {
    await fs.mkdir(root, { recursive: true });
    rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Invalid output directory: ${safeErrorPath(root) ?? 'path'}`);
    }
  }

  await fs.rm(path.join(root, MANIFEST_NAME), { recursive: true, force: true });
  await fs.rm(path.join(root, SIDECAR_NAME), { recursive: true, force: true });

  const { files: entries, hadSecretDir } = await collectRegularFiles(root);
  const files = [];
  let integrityFailed = hadSecretDir;

  for (const entry of entries) {
    const rel = entry.relPosix;
    const abs = entry.absPath;

    let st;
    try {
      st = await fs.lstat(abs);
    } catch {
      integrityFailed = true;
      continue;
    }

    if (st.isSymbolicLink()) {
      integrityFailed = true;
      try {
        await fs.unlink(abs);
      } catch {}
      continue;
    }

    if (!st.isFile()) {
      integrityFailed = true;
      continue;
    }

    let bytes;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      integrityFailed = true;
      continue;
    }

    const nameMatch = scanSecrets(rel);
    const dataMatch = scanSecrets(bytes);
    if (nameMatch || dataMatch) {
      integrityFailed = true;
      try {
        await fs.unlink(abs);
      } catch {}
      continue;
    }

    files.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
  }

  if (metadata && scanSecrets(JSON.stringify(metadata))) {
    integrityFailed = true;
  }

  const cleanMeta = sanitizeSecretsDeep(metadata || {});
  const gitCommit = cleanMeta.gitCommit ?? '';
  const versions = cleanMeta.versions ?? {};
  const originals = cleanMeta.originals ?? [];
  const steps = cleanMeta.steps ? { ...cleanMeta.steps } : {};

  if (integrityFailed) {
    steps.integrity = { ...(steps.integrity || {}), status: 'failed' };
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifest = {
    version: 1,
    gitCommit,
    versions,
    steps,
    originals,
    files,
    status: computeOverallStatus(steps, integrityFailed),
  };

  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (scanSecrets(manifestBytes)) {
    throw new Error('Manifest sanitation failed');
  }

  await fs.writeFile(path.join(root, MANIFEST_NAME), manifestBytes);
  await fs.writeFile(path.join(root, SIDECAR_NAME), sha256(manifestBytes), 'utf8');
  return manifest;
}

export async function verifyBackup(dir) {
  const root = path.resolve(dir);

  try {
    await assertNoSymlinkComponents(root);
  } catch {
    return { ok: false, errors: [{ code: 'INVALID_DIR' }] };
  }

  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch {
    return { ok: false, errors: [{ code: 'MISSING_DIR' }] };
  }

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ok: false, errors: [{ code: 'INVALID_DIR' }] };
  }

  const errors = [];
  const manifestPath = path.join(root, MANIFEST_NAME);
  const sidecarPath = path.join(root, SIDECAR_NAME);

  let manifestStat;
  try {
    manifestStat = await fs.lstat(manifestPath);
  } catch {
    return { ok: false, errors: [{ code: 'MISSING_MANIFEST' }] };
  }
  if (manifestStat.isSymbolicLink()) {
    return { ok: false, errors: [{ code: 'SYMLINK' }] };
  }

  let sidecarStat;
  try {
    sidecarStat = await fs.lstat(sidecarPath);
  } catch {
    return { ok: false, errors: [{ code: 'MISSING_SIDECAR' }] };
  }
  if (sidecarStat.isSymbolicLink()) {
    return { ok: false, errors: [{ code: 'SYMLINK' }] };
  }

  let manifestBytes;
  try {
    manifestBytes = await fs.readFile(manifestPath);
  } catch {
    return { ok: false, errors: [{ code: 'MISSING_MANIFEST' }] };
  }

  let sidecarText;
  try {
    sidecarText = await fs.readFile(sidecarPath, 'utf8');
  } catch {
    return { ok: false, errors: [{ code: 'MISSING_SIDECAR' }] };
  }

  const sidecarExpected = sidecarText.trim();
  if (!/^[a-f0-9]{64}$/.test(sidecarExpected)) {
    errors.push({ code: 'INVALID_SIDECAR' });
  } else if (sidecarExpected !== sha256(manifestBytes)) {
    errors.push({ code: 'SIDECAR_MISMATCH' });
  }

  if (scanSecrets(manifestBytes)) errors.push({ code: 'TOKEN_IN_MANIFEST' });
  if (scanSecrets(sidecarText)) errors.push({ code: 'TOKEN_IN_SIDECAR' });

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    errors.push({ code: 'INVALID_MANIFEST' });
    return { ok: false, errors };
  }

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push({ code: 'INVALID_MANIFEST' });
    return { ok: false, errors };
  }

  if (manifest.version !== 1) errors.push({ code: 'INVALID_VERSION' });
  if (typeof manifest.status !== 'string' || !['ok', 'failed'].includes(manifest.status)) {
    errors.push({ code: 'INVALID_STATUS' });
  } else if (manifest.status !== 'ok') {
    errors.push({ code: 'FAILED_MANIFEST' });
  }

  if (typeof manifest.gitCommit !== 'string' || manifest.gitCommit.length === 0) {
    errors.push({ code: 'INVALID_GIT_COMMIT' });
  }

  if (
    manifest.versions === null ||
    typeof manifest.versions !== 'object' ||
    Array.isArray(manifest.versions)
  ) {
    errors.push({ code: 'INVALID_VERSIONS' });
  }

  if (
    manifest.steps === null ||
    typeof manifest.steps !== 'object' ||
    Array.isArray(manifest.steps)
  ) {
    errors.push({ code: 'INVALID_STEPS' });
  } else {
    for (const [stepName, step] of Object.entries(manifest.steps)) {
      if (
        step === null ||
        typeof step !== 'object' ||
        Array.isArray(step) ||
        typeof step.status !== 'string' ||
        !['ok', 'failed', 'skipped'].includes(step.status) ||
        typeof step.required !== 'boolean'
      ) {
        errors.push({ code: 'INVALID_STEP', step: safeErrorPath(stepName) });
      }
    }

    if (manifest.status === 'ok' && computeOverallStatus(manifest.steps, false) !== 'ok') {
      errors.push({ code: 'STATUS_STEP_MISMATCH' });
    }
  }

  if (!Array.isArray(manifest.originals)) {
    errors.push({ code: 'INVALID_ORIGINALS' });
  } else {
    const originalSeen = new Set();
    for (const orig of manifest.originals) {
      if (
        orig === null ||
        typeof orig !== 'object' ||
        Array.isArray(orig) ||
        typeof orig.path !== 'string' ||
        !isSafeRelativePath(orig.path) ||
        typeof orig.size !== 'number' ||
        !Number.isInteger(orig.size) ||
        orig.size < 0 ||
        typeof orig.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(orig.sha256) ||
        typeof orig.copied !== 'boolean'
      ) {
        errors.push({ code: 'INVALID_ORIGINALS' });
        continue;
      }
      if (originalSeen.has(orig.path)) {
        errors.push({ code: 'DUPLICATE_ORIGINAL_PATH', path: safeErrorPath(orig.path) });
        continue;
      }
      originalSeen.add(orig.path);
    }
  }

  if (!Array.isArray(manifest.files)) {
    errors.push({ code: 'INVALID_FILES' });
    return { ok: false, errors };
  }

  const seen = new Set();
  const manifestByPath = new Map();

  for (const entry of manifest.files) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.path !== 'string' ||
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      errors.push({ code: 'INVALID_ENTRY' });
      continue;
    }

    const rel = entry.path;
    if (!isSafeRelativePath(rel)) {
      errors.push({ code: 'UNSAFE_PATH' });
      continue;
    }

    if (seen.has(rel)) {
      errors.push({ code: 'DUPLICATE_PATH', path: safeErrorPath(rel) });
      continue;
    }
    seen.add(rel);
    manifestByPath.set(rel, entry);
  }

  const actualFiles = new Map();

  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      errors.push({ code: 'READ_ERROR' });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        errors.push({ code: 'SYMLINK' });
        continue;
      }

      if (scanSecrets(rel)) {
        errors.push({ code: 'TOKEN_DETECTED' });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        if (rel === MANIFEST_NAME || rel === SIDECAR_NAME) continue;

        let bytes;
        try {
          bytes = await fs.readFile(abs);
        } catch {
          errors.push({ code: 'READ_ERROR', path: rel });
          continue;
        }

        if (scanSecrets(bytes)) {
          errors.push({ code: 'TOKEN_DETECTED', path: rel });
          continue;
        }

        actualFiles.set(rel, {
          path: rel,
          size: bytes.length,
          sha256: sha256(bytes),
        });
      } else {
        errors.push({ code: 'UNSUPPORTED_ENTRY' });
      }
    }
  }

  await walk(root, '');

  for (const [rel, entry] of manifestByPath) {
    const actual = actualFiles.get(rel);
    if (!actual) {
      errors.push({ code: 'MISSING_FILE', path: safeErrorPath(rel) });
    } else {
      if (entry.size !== actual.size) {
        errors.push({ code: 'SIZE_MISMATCH', path: rel });
      }
      if (entry.sha256 !== actual.sha256) {
        errors.push({ code: 'HASH_MISMATCH', path: rel });
      }
    }
  }

  for (const [rel] of actualFiles) {
    if (!manifestByPath.has(rel)) {
      errors.push({ code: 'EXTRA_FILE', path: safeErrorPath(rel) });
    }
  }

  return { ok: errors.length === 0, errors };
}
