import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertOutsideRepo, scanSecrets, inventoryOriginals, writeManifest, verifyBackup } from './files.mjs';
import { exportRoadmap } from './roadmap.mjs';
import { createRunner } from './run-command.mjs';
import { collectSupabase } from './supabase.mjs';
import { createGate } from '../roadmap/gate.mjs';
import { createGhTransport } from '../roadmap/github-transport.mjs';

const BACKUP_FORMAT = '1';
const STEP_NAMES = ['database', 'media', 'originals', 'roadmap', 'restore', 'integrity'];
const USAGE = 'Usage: node scripts/backup/backup.mjs --out <dir> [--include-originals] [--dry-run] | --verify <dir>';

function fail(step, code, dryRun = false, dir) {
  return { ok: false, dryRun, ...(dir ? { dir } : {}), error: { step, code } };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--include-originals' || arg === '--dry-run') {
      if (options[arg]) return null;
      options[arg] = true;
      continue;
    }
    if (arg === '--out' || arg === '--verify') {
      if (options.out || options.verify || !argv[i + 1] || argv[i + 1].startsWith('--')) return null;
      options[arg.slice(2)] = argv[++i];
      continue;
    }
    return null;
  }
  if (options.verify) return Object.keys(options).length === 1 ? options : null;
  return options.out && !options.verify ? options : null;
}

async function resolveGitCommit(repoRoot) {
  const marker = path.join(repoRoot, '.git');
  let gitDir;
  try {
    const stat = await fs.stat(marker);
    if (stat.isDirectory()) gitDir = marker;
    else {
      const text = await fs.readFile(marker, 'utf8');
      const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
      if (!match) throw new Error('invalid git marker');
      gitDir = path.resolve(repoRoot, match[1]);
    }
  } catch {
    throw new Error('git metadata unavailable');
  }

  let commonDir = gitDir;
  try {
    const value = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    if (value) commonDir = path.resolve(gitDir, value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('git metadata unavailable');
  }

  let head;
  try {
    head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    throw new Error('git metadata unavailable');
  }
  if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
  if (!ref || ref.includes('..') || path.isAbsolute(ref)) throw new Error('git metadata unavailable');

  for (const root of new Set([gitDir, commonDir])) {
    try {
      const value = (await fs.readFile(path.join(root, ref), 'utf8')).trim();
      if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('git metadata unavailable');
    }
    try {
      const packed = await fs.readFile(path.join(root, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        const match = /^([0-9a-f]{40})\s+(.+)$/.exec(line);
        if (match?.[2] === ref) return match[1].toLowerCase();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('git metadata unavailable');
    }
  }
  throw new Error('git metadata unavailable');
}

function restoreGuide(includeOriginals) {
  return `# Restore notes\n\nThis is a recovery archive, not an automated restore. Originals payload copied: ${includeOriginals ? 'yes' : 'no'}; see the manifest for the per-file inventory.\n\n## Prerequisites\n\nCreate and configure a compatible Supabase project, and use an owner-managed Supabase CLI login linked to that project. Recreate any required auth users before loading public data that references them. Reissue current credentials manually from their issuing providers; this archive never contains secret values.\n\n## Suggested order\n\n1. Apply the archived public schema, including its policies and functions.\n2. Recreate auth users, then load the public data dump so foreign keys can resolve.\n3. Recreate the private storage bucket and its access policies, then restore the archived media files. Check every payload against MANIFEST.json before relying on it.\n4. If originals were copied, restore them from the originals directory; otherwise the manifest records their names, sizes, and hashes only.\n5. Keep roadmap.json as an archive/reference snapshot, not as live project state.\n6. Manually reissue secrets and configuration from their providers; never copy values from a backup.\n\nA complete restore and access-control validation remain unverified; see issue #55.\n`;
}

export async function runBackup({
  out,
  repoRoot,
  originalsDir,
  includeOriginals = false,
  dryRun = false,
  now = () => new Date(),
  gitCommit,
  runner,
  gate,
  config,
} = {}) {
  if (typeof out !== 'string' || !out.trim() || typeof repoRoot !== 'string' || !repoRoot.trim()) {
    return fail('boundary', 'INVALID_ARGUMENT', dryRun);
  }

  let root;
  let date;
  try {
    root = await assertOutsideRepo(out, repoRoot);
    const timestamp = now();
    date = new Date(timestamp).toISOString().slice(0, 10);
  } catch {
    return fail('boundary', 'OUTPUT_PATH_INVALID', dryRun);
  }
  if (scanSecrets(root)) return fail('boundary', 'OUTPUT_PATH_INVALID', dryRun);

  const dir = path.join(root, `brainstorm-backup-${date}`);
  if (scanSecrets(dir)) return fail('boundary', 'OUTPUT_PATH_INVALID', dryRun);
  const plan = { dir, includeOriginals: Boolean(includeOriginals), steps: [...STEP_NAMES] };
  if (dryRun) return { ok: true, dryRun: true, dir, plan };

  if (typeof runner !== 'function' || typeof gate?.read !== 'function' || !config || typeof originalsDir !== 'string') {
    return fail('boundary', 'INJECTED_DEPENDENCIES_REQUIRED', false, dir);
  }

  let commit = gitCommit;
  if (commit === undefined) {
    try {
      commit = await resolveGitCommit(repoRoot);
    } catch {
      return fail('boundary', 'GIT_COMMIT_UNAVAILABLE', false, dir);
    }
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) {
    return fail('boundary', 'GIT_COMMIT_INVALID', false, dir);
  }

  try {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(dir);
  } catch (error) {
    return fail('boundary', error.code === 'EEXIST' ? 'DESTINATION_EXISTS' : 'DESTINATION_UNAVAILABLE', false, dir);
  }

  const steps = Object.fromEntries(STEP_NAMES.map((name) => [name, { status: 'skipped', required: true }]));
  const versions = { node: process.versions.node, backup: BACKUP_FORMAT };
  let originals = [];
  let failedStep;

  try {
    const collected = await collectSupabase({ dir, repoRoot, runner });
    versions.supabase = collected.versions.supabase;
    steps.database.status = 'ok';
    steps.media.status = 'ok';
  } catch (error) {
    failedStep = error?.step === 'media' ? 'media' : 'database';
    if (failedStep === 'media') steps.database.status = 'ok';
    steps[failedStep].status = 'failed';
  }

  if (!failedStep) {
    try {
      originals = await inventoryOriginals(originalsDir, includeOriginals ? { copyTo: path.join(dir, 'originals') } : {});
      steps.originals.status = 'ok';
    } catch {
      failedStep = 'originals';
      steps.originals.status = 'failed';
    }
  }

  if (!failedStep) {
    try {
      const snapshot = await exportRoadmap({ gate, config });
      await fs.writeFile(path.join(dir, 'roadmap.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
      steps.roadmap.status = 'ok';
    } catch {
      failedStep = 'roadmap';
      steps.roadmap.status = 'failed';
    }
  }

  if (!failedStep) {
    try {
      await fs.writeFile(path.join(dir, 'RESTORE.md'), restoreGuide(includeOriginals), { flag: 'wx' });
      steps.restore.status = 'ok';
    } catch {
      failedStep = 'restore';
      steps.restore.status = 'failed';
    }
  }

  steps.integrity.status = 'ok';
  let manifest;
  try {
    manifest = await writeManifest(dir, { gitCommit: commit.toLowerCase(), versions, originals, steps });
  } catch {
    return fail('integrity', 'MANIFEST_WRITE_FAILED', false, dir);
  }

  if (manifest.status === 'ok') {
    const verification = await verifyBackup(dir).catch(() => ({ ok: false }));
    if (verification.ok) return { ok: true, dryRun: false, dir, manifest };
    steps.integrity.status = 'failed';
    try {
      manifest = await writeManifest(dir, { gitCommit: commit.toLowerCase(), versions, originals, steps });
    } catch {
      return fail('integrity', 'VERIFY_FAILED', false, dir);
    }
    failedStep = 'integrity';
  } else if (!failedStep) {
    failedStep = 'integrity';
  }

  return { ok: false, dryRun: false, dir, manifest, error: { step: failedStep, code: 'REQUIRED_STEP_FAILED' } };
}

async function runCli(argv, { out = (text) => process.stdout.write(`${text}\n`) } = {}) {
  const options = parseArgs(argv);
  if (!options) {
    out(USAGE);
    return 2;
  }
  if (options.verify) {
    const result = await verifyBackup(options.verify).catch(() => ({ ok: false }));
    out(result.ok ? 'Backup verification passed.' : 'Backup verification failed.');
    return result.ok ? 0 : 1;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dryRun = Boolean(options['--dry-run']);
  const result = await runBackup({
    out: options.out,
    repoRoot,
    originalsDir: path.join(repoRoot, 'music quiz originals'),
    includeOriginals: Boolean(options['--include-originals']),
    dryRun,
    ...(dryRun ? {} : {
      runner: createRunner(),
      gate: createGate({ transport: createGhTransport() }),
      config: JSON.parse(await fs.readFile(path.join(repoRoot, 'docs/roadmap/config.json'), 'utf8')),
    }),
  });

  if (!result.ok) {
    out(`Backup failed (${result.error?.step ?? 'backup'}).`);
    return 1;
  }
  out(dryRun ? JSON.stringify(result.plan) : `Backup created: ${result.dir}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Backup failed.\n');
    process.exitCode = 1;
  });
}
