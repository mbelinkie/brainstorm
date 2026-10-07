import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { exportRoadmap } from '../scripts/backup/roadmap.mjs';
import { createGate } from '../scripts/roadmap/gate.mjs';
import { createBudget } from '../scripts/roadmap/rate-limit.mjs';

import {
  assertOutsideRepo,
  scanSecrets,
  inventoryOriginals,
  writeManifest,
  verifyBackup,
} from '../scripts/backup/files.mjs';
import { createRunner } from '../scripts/backup/run-command.mjs';
import { parseMediaRows, collectSupabase } from '../scripts/backup/supabase.mjs';
import { runBackup } from '../scripts/backup/backup.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const jwt = (role) =>
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') +
  '.' +
  Buffer.from(JSON.stringify({ role })).toString('base64url') +
  '.' +
  Buffer.alloc(32, 7).toString('base64url');

const tokens = [
  'ghp_' + 'a'.repeat(36),
  'github_pat_' + 'b'.repeat(60),
  'sb_secret_' + 'c'.repeat(35),
  jwt('service_role'),
];

const mkdtemp = async (prefix) => {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, prefix));
};

test('assertOutsideRepo rejects repo paths and symlink aliases', async (t) => {
  const scratch = await mkdtemp('backup-assert-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repo = path.join(scratch, 'repo');
  await fs.mkdir(repo);
  const outside = path.join(scratch, 'out');

  const returned = await assertOutsideRepo(outside, repo);
  assert.equal(path.isAbsolute(returned), true);
  assert.equal(returned.startsWith(repo), false);

  await assert.rejects(() => assertOutsideRepo(repo, repo));
  await assert.rejects(() => assertOutsideRepo(path.join(repo, 'child'), repo));

  const alias = path.join(scratch, 'alias');
  await fs.symlink(repo, alias);
  await assert.rejects(() => assertOutsideRepo(path.join(alias, 'new'), repo));

  const siblingReturn = await assertOutsideRepo(repo + '-sibling', repo);
  assert.equal(path.isAbsolute(siblingReturn), true);
});

test('filesystem boundary regressions: assertOutsideRepo, inventory destination, manifest ancestor, verify manifest symlink', async (t) => {
  const scratch = await mkdtemp('backup-boundary-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const metadata = () => ({
    gitCommit: 'boundary',
    versions: { node: '26.5.0' },
    steps: {
      database: { status: 'ok', required: true },
      originals: { status: 'ok', required: true },
    },
    originals: [],
  });

  const repoHidden = path.join(scratch, 'repo-hidden');
  await fs.mkdir(repoHidden);
  await assert.rejects(() => assertOutsideRepo(path.join(repoHidden, '..cache'), repoHidden));

  const repoAlias = path.join(scratch, 'repo-alias');
  const outward = path.join(scratch, 'outward');
  await fs.mkdir(repoAlias);
  await fs.mkdir(outward);
  await fs.symlink(outward, path.join(repoAlias, 'escape'));
  await assert.rejects(() => assertOutsideRepo(path.join(repoAlias, 'escape', 'new'), repoAlias));

  const originalsRoot = path.join(scratch, 'originals-root');
  await fs.mkdir(originalsRoot);
  await fs.writeFile(path.join(originalsRoot, 'a'), 'source');
  const copyRootOutside = path.join(scratch, 'copy-root-outside');
  await fs.mkdir(copyRootOutside);
  const copyRootAlias = path.join(scratch, 'copy-root-alias');
  await fs.symlink(copyRootOutside, copyRootAlias);
  await assert.rejects(() => inventoryOriginals(originalsRoot, { copyTo: copyRootAlias }));
  assert.deepEqual(await fs.readdir(copyRootOutside), []);

  const originalsDest = path.join(scratch, 'originals-destination');
  await fs.mkdir(originalsDest);
  await fs.writeFile(path.join(originalsDest, 'a'), 'source');
  const copyDest = path.join(scratch, 'copy-destination');
  await fs.mkdir(copyDest);
  const outsideTarget = path.join(scratch, 'outside-copy-target');
  await fs.writeFile(outsideTarget, 'unchanged');
  await fs.symlink(outsideTarget, path.join(copyDest, 'a'));
  await assert.rejects(() => inventoryOriginals(originalsDest, { copyTo: copyDest }));
  assert.equal(await fs.readFile(outsideTarget, 'utf8'), 'unchanged');

  const manifestOutside = path.join(scratch, 'manifest-outside');
  await fs.mkdir(manifestOutside);
  const manifestAlias = path.join(scratch, 'manifest-alias');
  await fs.symlink(manifestOutside, manifestAlias);
  await assert.rejects(() => writeManifest(path.join(manifestAlias, 'new'), metadata()));
  assert.deepEqual(await fs.readdir(manifestOutside), []);

  const backupDir = path.join(scratch, 'manifest-symlink-backup');
  await fs.mkdir(backupDir);
  await fs.writeFile(path.join(backupDir, 'RESTORE.md'), 'restore');
  await writeManifest(backupDir, metadata());
  const externalManifest = path.join(scratch, 'external-manifest');
  await fs.copyFile(path.join(backupDir, 'MANIFEST.json'), externalManifest);
  await fs.unlink(path.join(backupDir, 'MANIFEST.json'));
  await fs.symlink(externalManifest, path.join(backupDir, 'MANIFEST.json'));
  assert.equal((await verifyBackup(backupDir)).ok, false);
});

test('scanSecrets detects known token shapes and service-role JWT', () => {
  for (const token of tokens) {
    assert.equal(scanSecrets(`prefix ${token} suffix`), true);
  }
  assert.equal(scanSecrets(jwt('anon')), false);
  assert.equal(scanSecrets('SUPABASE_SERVICE_ROLE_KEY= # name only'), false);

  const binary = Buffer.concat([
    Buffer.alloc(65530),
    Buffer.from(tokens[0]),
    Buffer.from([0, 255]),
  ]);
  assert.equal(scanSecrets(binary), true);
});

test('inventoryOriginals lists nested files, copies only with copyTo, rejects symlinks', async (t) => {
  const scratch = await mkdtemp('backup-orig-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const originals = path.join(scratch, 'originals');
  await fs.mkdir(path.join(originals, 'nested'), { recursive: true });
  await fs.writeFile(path.join(originals, 'nested', 'original song.wav'), 'sound');
  await fs.writeFile(path.join(originals, 'z-last.txt'), 'last');

  const listed = await inventoryOriginals(originals);
  assert.deepEqual(listed, [
    {
      path: 'nested/original song.wav',
      size: 5,
      sha256: sha('sound'),
      copied: false,
    },
    {
      path: 'z-last.txt',
      size: 4,
      sha256: sha('last'),
      copied: false,
    },
  ]);

  const copyTo = path.join(scratch, 'copy');
  const copiedList = await inventoryOriginals(originals, { copyTo });
  assert.equal(copiedList[0].copied, true);
  assert.equal(
    await fs.readFile(path.join(copyTo, 'nested', 'original song.wav'), 'utf8'),
    'sound',
  );

  await assert.rejects(() => inventoryOriginals(path.join(scratch, 'missing')));

  await fs.symlink(
    path.join(originals, 'nested', 'original song.wav'),
    path.join(originals, 'link'),
  );
  await assert.rejects(() => inventoryOriginals(originals));
});

test('writeManifest and verifyBackup integrity checks', async (t) => {
  const scratch = await mkdtemp('backup-manifest-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const dir = path.join(scratch, 'manifest');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'RESTORE.md'), 'restore');
  await fs.mkdir(path.join(dir, 'database'));
  await fs.writeFile(path.join(dir, 'database', 'data.sql'), 'data');

  const metadata = {
    gitCommit: 'basec',
    versions: { node: '26.5.0', supabase: '2.119.0', backup: '1' },
    steps: {
      database: { status: 'ok', required: true },
      integrity: { status: 'ok', required: true },
    },
    originals: [],
  };

  const manifest = await writeManifest(dir, metadata);
  assert.equal(manifest.status, 'ok');
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.files.map((f) => f.path), ['RESTORE.md', 'database/data.sql']);
  assert.equal((await verifyBackup(dir)).ok, true);

  await fs.writeFile(path.join(dir, 'database', 'data.sql'), 'changed');
  assert.equal((await verifyBackup(dir)).ok, false);
  await fs.writeFile(path.join(dir, 'database', 'data.sql'), 'data');

  await fs.unlink(path.join(dir, 'RESTORE.md'));
  assert.equal((await verifyBackup(dir)).ok, false);
  await fs.writeFile(path.join(dir, 'RESTORE.md'), 'restore');

  await fs.writeFile(path.join(dir, 'extra'), 'x');
  assert.equal((await verifyBackup(dir)).ok, false);
  await fs.unlink(path.join(dir, 'extra'));

  const manifestPath = path.join(dir, 'MANIFEST.json');
  const sidecarPath = path.join(dir, 'MANIFEST.sha256');
  const originalManifest = await fs.readFile(manifestPath, 'utf8');
  const sidecar = await fs.readFile(sidecarPath, 'utf8');

  const bad = JSON.parse(originalManifest);
  bad.files[0].size++;
  await fs.writeFile(manifestPath, JSON.stringify(bad));
  await fs.writeFile(sidecarPath, sha(Buffer.from(JSON.stringify(bad))) + '\n');
  assert.equal((await verifyBackup(dir)).ok, false);

  await fs.writeFile(manifestPath, originalManifest);
  await fs.writeFile(sidecarPath, sidecar);

  for (const p of ['../outside', '/absolute', manifest.files[1].path]) {
    const hostile = JSON.parse(originalManifest);
    hostile.files[0].path = p;
    await fs.writeFile(manifestPath, JSON.stringify(hostile));
    await fs.writeFile(sidecarPath, sha(Buffer.from(JSON.stringify(hostile))) + '\n');
    assert.equal((await verifyBackup(dir)).ok, false);
  }

  await fs.writeFile(manifestPath, originalManifest);
  await fs.writeFile(sidecarPath, sidecar);

  await fs.unlink(path.join(dir, 'database', 'data.sql'));
  await fs.symlink(path.join(scratch, 'outside-target'), path.join(dir, 'database', 'data.sql'));
  assert.equal((await verifyBackup(dir)).ok, false);
});

test('writeManifest removes contaminated artifacts and sanitizes metadata', async (t) => {
  const scratch = await mkdtemp('backup-secret-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  for (let i = 0; i < tokens.length; i++) {
    const dir = path.join(scratch, `secret-${i}`);
    await fs.mkdir(dir);
    const bytes = Buffer.concat([
      Buffer.alloc(65530),
      Buffer.from(tokens[i]),
      Buffer.from([0, 255]),
    ]);
    await fs.writeFile(path.join(dir, 'artifact.bin'), bytes);

    const metadata = {
      gitCommit: 'c',
      versions: { node: '24' },
      steps: { integrity: { status: 'ok', required: true } },
      originals: [],
    };

    const m = await writeManifest(dir, metadata);
    assert.equal(m.status, 'failed');
    assert.equal(m.steps.integrity.status, 'failed');
    assert.equal(
      scanSecrets(await fs.readFile(path.join(dir, 'MANIFEST.json'), 'utf8')),
      false,
    );
    await assert.rejects(() => fs.access(path.join(dir, 'artifact.bin')));
    assert.equal((await verifyBackup(dir)).ok, false);
  }

  const nameDir = path.join(scratch, 'secret-name');
  await fs.mkdir(nameDir);
  await fs.writeFile(path.join(nameDir, tokens[0]), 'safe');
  const metadata1 = {
    gitCommit: 'c',
    versions: {},
    steps: { integrity: { status: 'ok', required: true } },
    originals: [],
  };
  const m1 = await writeManifest(nameDir, metadata1);
  assert.equal(m1.status, 'failed');
  for (const name of await fs.readdir(nameDir)) {
    assert.equal(scanSecrets(name), false);
    assert.equal(
      scanSecrets(await fs.readFile(path.join(nameDir, name), 'utf8')),
      false,
    );
  }

  const metaDir = path.join(scratch, 'secret-meta');
  await fs.mkdir(metaDir);
  const badMetadata = {
    gitCommit: 'c',
    versions: { supabase: tokens[1] },
    steps: { integrity: { status: 'ok', required: true } },
    originals: [],
  };
  const m2 = await writeManifest(metaDir, badMetadata);
  assert.equal(m2.status, 'failed');
  assert.equal(
    scanSecrets(await fs.readFile(path.join(metaDir, 'MANIFEST.json'), 'utf8')),
    false,
  );
});

test('writeManifest derives failed status from required step failures and verifyBackup validates malformed manifests', async (t) => {
  const scratch = await mkdtemp('backup-status-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  // Required step failure -> manifest failed, verify false
  const dirReq = path.join(scratch, 'required-fail');
  await fs.mkdir(dirReq);
  const meta = {
    gitCommit: 'c',
    versions: { node: '24' },
    steps: {
      database: { status: 'failed', required: true },
      integrity: { status: 'ok', required: true },
    },
    originals: [],
  };
  const mReq = await writeManifest(dirReq, meta);
  assert.equal(mReq.status, 'failed');
  assert.equal((await verifyBackup(dirReq)).ok, false);

  // Required step skipped -> failed
  const dirSkip = path.join(scratch, 'required-skip');
  await fs.mkdir(dirSkip);
  const metaSkip = {
    gitCommit: 'c',
    versions: { node: '24' },
    steps: { database: { status: 'skipped', required: true } },
    originals: [],
  };
  const mSkip = await writeManifest(dirSkip, metaSkip);
  assert.equal(mSkip.status, 'failed');
  assert.equal((await verifyBackup(dirSkip)).ok, false);

  // Optional skipped step still ok overall
  const dirOpt = path.join(scratch, 'optional-skip');
  await fs.mkdir(dirOpt);
  const metaOpt = {
    gitCommit: 'c',
    versions: { node: '24' },
    steps: { optional: { status: 'skipped', required: false } },
    originals: [],
  };
  const mOpt = await writeManifest(dirOpt, metaOpt);
  assert.equal(mOpt.status, 'ok');
  assert.equal((await verifyBackup(dirOpt)).ok, true);

  // Token-shaped metadata object key is omitted and manifest failed
  const dirKey = path.join(scratch, 'metadata-key');
  await fs.mkdir(dirKey);
  const metaKey = {
    gitCommit: 'c',
    versions: { safe: 'value', [tokens[2]]: 'safe-value' },
    steps: { integrity: { status: 'ok', required: true } },
    originals: [],
  };
  const mKey = await writeManifest(dirKey, metaKey);
  assert.equal(mKey.status, 'failed');
  const keyManifest = JSON.parse(await fs.readFile(path.join(dirKey, 'MANIFEST.json'), 'utf8'));
  assert.equal('safe' in keyManifest.versions, true);
  assert.equal(scanSecrets(JSON.stringify(keyManifest)), false);

  // Token-shaped directory name removed with failed manifest
  const dirTokenDir = path.join(scratch, 'token-directory');
  await fs.mkdir(path.join(dirTokenDir, tokens[1]), { recursive: true });
  await fs.writeFile(path.join(dirTokenDir, tokens[1], 'child.txt'), 'child');
  const mTokenDir = await writeManifest(dirTokenDir, {
    gitCommit: 'c',
    versions: {},
    steps: { integrity: { status: 'ok', required: true } },
    originals: [],
  });
  assert.equal(mTokenDir.status, 'failed');
  assert.equal((await fs.readdir(dirTokenDir)).some(name => scanSecrets(name)), false);

  // verifyBackup returns false for null/array/non-object JSON and malformed required structure
  const dirNull = path.join(scratch, 'null-manifest');
  await fs.mkdir(dirNull);
  await fs.writeFile(path.join(dirNull, 'MANIFEST.json'), 'null');
  await fs.writeFile(path.join(dirNull, 'MANIFEST.sha256'), sha('null'));
  assert.equal((await verifyBackup(dirNull)).ok, false);

  const dirArr = path.join(scratch, 'array-manifest');
  await fs.mkdir(dirArr);
  await fs.writeFile(path.join(dirArr, 'MANIFEST.json'), '[]');
  await fs.writeFile(path.join(dirArr, 'MANIFEST.sha256'), sha('[]'));
  assert.equal((await verifyBackup(dirArr)).ok, false);

  const dirMalformed = path.join(scratch, 'malformed-manifest');
  await fs.mkdir(dirMalformed);
  const malformed = {
    version: 1,
    status: 'ok',
    gitCommit: '',
    versions: {},
    steps: { database: { status: 'bad', required: true } },
    originals: [],
    files: [],
  };
  await fs.writeFile(path.join(dirMalformed, 'MANIFEST.json'), JSON.stringify(malformed));
  await fs.writeFile(path.join(dirMalformed, 'MANIFEST.sha256'), sha(Buffer.from(JSON.stringify(malformed))));
  assert.equal((await verifyBackup(dirMalformed)).ok, false);
});

test('verifyBackup rejects contradictory step status, malformed unsafe duplicate originals, and secret-shaped empty directory', async (t) => {
  const scratch = await mkdtemp('backup-verify-holes-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const baseMetadata = () => ({
    gitCommit: 'holes',
    versions: { node: '26.5.0' },
    steps: {
      database: { status: 'ok', required: true },
    },
    originals: [],
  });

  const patchManifest = async (dir, update) => {
    const manifestPath = path.join(dir, 'MANIFEST.json');
    const sidecarPath = path.join(dir, 'MANIFEST.sha256');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    update(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(manifestPath, bytes);
    await fs.writeFile(sidecarPath, sha(bytes) + '\n');
  };

  // Required steps that are failed or skipped cannot be hidden by manifest.status:'ok'.
  for (const status of ['failed', 'skipped']) {
    const dir = path.join(scratch, `step-${status}`);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'RESTORE.md'), 'restore');
    await writeManifest(dir, baseMetadata());
    await patchManifest(dir, (manifest) => {
      manifest.steps.database.status = status;
      manifest.status = 'ok';
    });
    assert.equal((await verifyBackup(dir)).ok, false);
  }

  // Originals references must be structurally sound; valid copied:false entries do not need payload.
  const originalsDir = path.join(scratch, 'originals-entry-validation');
  await fs.mkdir(originalsDir);
  await fs.writeFile(path.join(originalsDir, 'RESTORE.md'), 'restore');

  const validOriginal = {
    path: 'nested/original.wav',
    size: 5,
    sha256: sha('sound'),
    copied: false,
  };

  const invalidOriginals = [
    [null],
    ['bad'],
    [{ ...validOriginal, path: '../escape' }],
    [{ ...validOriginal, path: '/outside' }],
    [validOriginal, validOriginal],
    [{ ...validOriginal, copied: 'false' }],
    [{ ...validOriginal, size: -1 }],
    [{ ...validOriginal, sha256: 'bad' }],
  ];

  for (const originals of invalidOriginals) {
    await writeManifest(originalsDir, { ...baseMetadata(), originals });
    assert.equal((await verifyBackup(originalsDir)).ok, false);
  }

  await writeManifest(originalsDir, { ...baseMetadata(), originals: [validOriginal] });
  assert.equal((await verifyBackup(originalsDir)).ok, true, 'uncopied valid originals references do not require source payload');

  // Secret-shaped empty directory must be rejected before descending.
  const tokenDir = path.join(scratch, 'token-empty-dir');
  await fs.mkdir(tokenDir);
  await fs.writeFile(path.join(tokenDir, 'RESTORE.md'), 'restore');
  await writeManifest(tokenDir, baseMetadata());
  const tokenName = 'sb_secret_' + 'q'.repeat(35);
  await fs.mkdir(path.join(tokenDir, tokenName));
  assert.equal((await verifyBackup(tokenDir)).ok, false);
});

// Roadmap export real-function tests with injected fake gates.

const roadmapConfig = {
  repository: { owner: 'mbelinkie', name: 'brainstorm' },
  project: { owner: 'mbelinkie', ownerType: 'user', number: 4 },
};

const issue = (n, state = n === 1 ? 'OPEN' : 'CLOSED') => ({
  id: `I${n}`,
  number: n,
  title: `issue ${n}`,
  body: 'contract',
  state,
  url: `https://github.com/mbelinkie/brainstorm/issues/${n}`,
});

const parentIssue = {
  id: 'PARENT',
  number: 10,
  url: 'https://github.com/mbelinkie/brainstorm/issues/10',
  repository: { nameWithOwner: 'mbelinkie/brainstorm' },
};

const fixtureComments = [
  { id: 'C1', body: 'first', createdAt: '2026-01-01', author: { login: 'owner' }, url: 'https://github.com/comment/1' },
  { id: 'C2', body: 'second', createdAt: '2026-01-02', author: null, url: 'https://github.com/comment/2' },
];
const fixtureLabels = [
  { id: 'L1', name: 'model:standard' },
  { id: 'L2', name: 'effort:medium' },
];
const fixtureBlockedBy = [
  { id: 'D1', number: 13, url: 'https://github.com/mbelinkie/brainstorm/issues/13', repository: { nameWithOwner: 'mbelinkie/brainstorm' } },
  { id: 'D2', number: 14, url: 'https://github.com/other/repo/issues/14', repository: { nameWithOwner: 'other/repo' } },
];

const pathMap = {
  BackupIssues: ['repository', 'issues'],
  BackupComments: ['repository', 'issue', 'comments'],
  BackupLabels: ['repository', 'issue', 'labels'],
  BackupBlockedBy: ['repository', 'issue', 'blockedBy'],
  BackupItems: ['user', 'projectV2', 'items'],
  BackupFields: ['node', 'fieldValues'],
};

function nest(keys, value) {
  return keys.reduceRight((v, k) => ({ [k]: v }), value);
}

function pagedNodes(nodes, cursor) {
  if (cursor == null) {
    return { nodes: nodes.slice(0, 1), pageInfo: { hasNextPage: nodes.length > 1, endCursor: nodes.length > 1 ? 'next' : null } };
  }
  if (cursor === 'next') {
    return { nodes: nodes.slice(1), pageInfo: { hasNextPage: false, endCursor: null } };
  }
  return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}

function makeRoadmapFakeGate(options = {}) {
  const calls = [];
  const gate = {
    calls,
    async read({ query, variables = {}, requireComplete } = {}) {
      const op = String(query).match(/query\s+(\w+)/)?.[1];
      calls.push({ op, variables, requireComplete, query });
      if (options.failOperation === op) {
        return { ok: false, code: 'THROTTLED', message: 'fixture refusal' };
      }
      if (op === 'BackupParent') {
        const issueNumber = variables.issueNumber;
        const parent = options.nullParent && issueNumber === 1 ? null : parentIssue;
        return { ok: true, data: { repository: { issue: { parent } } }, complete: true, incomplete: [] };
      }
      if (!pathMap[op]) {
        return { ok: false, code: 'BAD_REQUEST', message: 'unexpected operation' };
      }
      let nodes;
      if (op === 'BackupIssues') {
        nodes = [issue(1), issue(2)];
      } else if (op === 'BackupComments') {
        nodes = fixtureComments;
      } else if (op === 'BackupLabels') {
        nodes = fixtureLabels;
      } else if (op === 'BackupBlockedBy') {
        nodes = fixtureBlockedBy;
      } else if (op === 'BackupItems') {
        nodes = [
          { id: 'P1', type: 'ISSUE', isArchived: false, content: issue(1) },
          { id: 'P2', type: 'DRAFT_ISSUE', isArchived: false, content: { __typename: 'DraftIssue', id: 'DR1', title: 'draft', body: 'draft body' } },
        ];
        if (options.unknownContentType) {
          nodes[0].content = { __typename: 'FutureContent', id: 'FC1' };
        }
        if (options.unknownItemType) {
          nodes[1].type = 'UNKNOWN';
        }
      } else if (op === 'BackupFields') {
        const itemId = variables.itemId;
        nodes = [
          { __typename: 'ProjectV2ItemFieldTextValue', id: `F_${itemId}_1`, text: 'text', field: { id: `FD_${itemId}_1`, name: 'Notes' } },
          { __typename: 'ProjectV2ItemFieldSingleSelectValue', id: `F_${itemId}_2`, name: 'option', optionId: 'opt1', color: 'BLUE', field: { id: `FD_${itemId}_2`, name: 'Priority' } },
        ];
      } else {
        nodes = [];
      }
      let page = pagedNodes(nodes, variables.cursor);
      if (options.stuckOperation === op) {
        page = { nodes: nodes.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: 'next' } };
      }
      if (options.missingCursorOperation === op) {
        page = { nodes: nodes.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: null } };
      }
      const connectionPath = pathMap[op].join('.');
      const data = nest(pathMap[op], { nodes: page.nodes, pageInfo: page.pageInfo });
      const incomplete = page.pageInfo.hasNextPage ? [connectionPath] : [];
      return { ok: true, data, complete: !page.pageInfo.hasNextPage, incomplete };
    },
  };
  return gate;
}

test('roadmap export pages all connections and retains native/draft content', async () => {
  const gate = makeRoadmapFakeGate();
  const data = await exportRoadmap({ gate, config: roadmapConfig });
  assert.equal(data.complete, true);
  assert.equal(data.repository, 'mbelinkie/brainstorm');
  assert.equal(data.project.number, 4);
  assert.equal(data.issues.length, 2);
  for (const iss of data.issues) {
    assert.equal(iss.comments.length, 2);
    assert.equal(iss.labels.length, 2);
    assert.equal(iss.blockedBy.length, 2);
    assert.equal(iss.parent.number, 10);
  }
  assert.equal(data.project.items.length, 2);
  const [item1, item2] = data.project.items;
  assert.equal(item1.type, 'ISSUE');
  assert.deepEqual(item1.content, issue(1));
  assert.equal(item2.type, 'DRAFT_ISSUE');
  assert.equal(item2.content.title, 'draft');
  assert.equal(item1.fieldValues.length, 2);
  assert.equal(item2.fieldValues.length, 2);
  assert.ok(gate.calls.some(c => c.op === 'BackupIssues' && c.variables.cursor === 'next'));
  assert.ok(gate.calls.some(c => c.op === 'BackupComments' && c.variables.cursor === 'next'));
});

test('roadmap export rejects unknown content/type with sanitized errors', async () => {
  await assert.rejects(
    () => exportRoadmap({ gate: makeRoadmapFakeGate({ unknownContentType: true }), config: roadmapConfig }),
    /Unsupported project item content type/,
  );
  await assert.rejects(
    () => exportRoadmap({ gate: makeRoadmapFakeGate({ unknownItemType: true }), config: roadmapConfig }),
    /Unsupported project item type/,
  );
});

test('roadmap export fails closed on refusal/repeated/missing cursors', async () => {
  await assert.rejects(
    () => exportRoadmap({ gate: makeRoadmapFakeGate({ failOperation: 'BackupComments' }), config: roadmapConfig }),
    /Roadmap gate refused/,
  );
  await assert.rejects(
    () => exportRoadmap({ gate: makeRoadmapFakeGate({ stuckOperation: 'BackupComments' }), config: roadmapConfig }),
    /missing or repeated cursor/,
  );
  await assert.rejects(
    () => exportRoadmap({ gate: makeRoadmapFakeGate({ missingCursorOperation: 'BackupComments' }), config: roadmapConfig }),
    /missing or repeated cursor/,
  );
});

test('real createGate with fake transport propagates HTTP-200 GraphQL error', async () => {
  const now = () => Date.parse('2026-10-01T00:00:00Z');
  const budget = createBudget({ now });
  const gate = createGate({
    lock: { acquire: () => ({ ok: true, release() {} }) },
    transport: {
      async request(request) {
        if (request.query?.includes('RoadmapRateLimit')) {
          return {
            status: 200,
            headers: {},
            body: { data: { rateLimit: { limit: 5000, remaining: 4000, used: 1000, resetAt: new Date(now() + 3600000).toISOString(), cost: 1 } } },
          };
        }
        return { status: 200, headers: {}, body: { errors: [{ message: 'fixture failure', type: 'TEST_ERROR' }] } };
      },
    },
    now,
    sleep: async () => {},
    log: () => {},
  });
  await assert.rejects(() => exportRoadmap({ gate, config: roadmapConfig }));
});

test('run-command uses hardcoded supabase, sanitized env, and accepts detached output destinations', async (t) => {
  const scratch = await mkdtemp('backup-run-command-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repoRoot = path.join(scratch, 'repo');
  const backupDir = path.join(scratch, 'backup');

  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '' };
  };
  const run = createRunner({ spawn: fakeSpawn });

  const versionResult = await run({ step: 'version', args: ['--version'], cwd: repoRoot });
  assert.equal(versionResult.ok, true);
  assert.equal(versionResult.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'supabase');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, repoRoot);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.equal(calls[0].options.maxBuffer, 10 * 1024 * 1024);
  assert.ok(calls[0].options.env);
  assert.equal(Object.hasOwn(calls[0].options.env, 'SUPABASE_SERVICE_ROLE_KEY'), false);
  assert.equal(Object.hasOwn(calls[0].options.env, 'NODE_OPTIONS'), false);

  const schemaDest = path.join(backupDir, 'database', 'schema.sql');
  calls.length = 0;
  const schemaResult = await run({
    step: 'schema',
    args: ['db', 'dump', '--linked', '--schema', 'public', '--file', schemaDest],
    cwd: repoRoot,
    output: schemaDest,
  });
  assert.equal(schemaResult.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['db', 'dump', '--linked', '--schema', 'public', '--file', schemaDest]);
  assert.equal(calls[0].options.cwd, repoRoot);

  const dataDest = path.join(backupDir, 'database', 'data.sql');
  calls.length = 0;
  const dataResult = await run({
    step: 'data',
    args: ['db', 'dump', '--linked', '--schema', 'public', '--data-only', '--use-copy', '--file', dataDest],
    cwd: repoRoot,
    output: dataDest,
  });
  assert.equal(dataResult.ok, true);
  assert.deepEqual(calls[0].args, ['db', 'dump', '--linked', '--schema', 'public', '--data-only', '--use-copy', '--file', dataDest]);
  assert.equal(calls[0].options.cwd, repoRoot);

  const mediaPath = 'author/audio.wav';
  const mediaDest = path.join(backupDir, 'media', mediaPath);
  calls.length = 0;
  const mediaResult = await run({
    step: 'media',
    args: ['storage', 'cp', '--linked', '--experimental', `ss:///quiz-media/${mediaPath}`, mediaDest],
    cwd: repoRoot,
    output: mediaDest,
  });
  assert.equal(mediaResult.ok, true);
  assert.deepEqual(calls[0].args, ['storage', 'cp', '--linked', '--experimental', `ss:///quiz-media/${mediaPath}`, mediaDest]);
  assert.equal(calls[0].options.cwd, repoRoot);
});

test('run-command refuses invalid shapes, uploads, traversal, and override keys before spawn', async (t) => {
  const scratch = await mkdtemp('backup-run-command-invalid-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repoRoot = path.join(scratch, 'repo');
  const backupDir = path.join(scratch, 'backup');
  let spawnCount = 0;
  const run = createRunner({
    spawn: () => {
      spawnCount += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const invalidRequests = [
    { step: 'version', args: ['--version', '--password', 'fake'], cwd: repoRoot },
    { step: 'version', args: [], cwd: repoRoot },
    { step: 'schema', args: ['db', 'dump', '--linked', '--schema', 'public', '--file', 'database/schema.sql'], cwd: repoRoot },
    { step: 'schema', args: ['db', 'dump', '--linked', '--schema', 'public', '--file', path.join(backupDir, 'database', 'schema.sql')], cwd: repoRoot, shell: true },
    { step: 'schema', args: ['db', 'dump', '--linked', '--schema', 'public', '--file', path.join(backupDir, 'database', 'schema.sql')], cwd: repoRoot, command: 'gh' },
    { step: 'data', args: ['db', 'dump', '--linked', '--schema', 'public', '--data-only', '--use-copy', '--file', path.join(repoRoot, 'database', 'data.sql')], cwd: repoRoot, output: path.join(backupDir, 'database', 'data.sql') },
    { step: 'media', args: ['storage', 'cp', '--linked', '--experimental', 'ss:///quiz-media/author/audio.wav', path.join(backupDir, 'media', 'author', 'audio.wav')], cwd: repoRoot, output: path.join(backupDir, 'different.sql') },
    { step: 'media', args: ['storage', 'cp', '--linked', '--experimental', 'ss:///quiz-media/../escape.wav', path.join(backupDir, 'media', 'escape.wav')], cwd: repoRoot },
    { step: 'media', args: ['storage', 'cp', '--linked', '--experimental', 'ss:///quiz-media/author/audio.wav', 'ss:///quiz-media/author/audio.wav'], cwd: repoRoot },
    { step: 'media', args: ['storage', 'cp', '--linked', 'ss:///quiz-media/author/audio.wav', path.join(backupDir, 'media', 'author', 'audio.wav')], cwd: repoRoot },
  ];

  for (const request of invalidRequests) {
    const before = spawnCount;
    const result = await run(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(spawnCount, before, 'spawn must not be called for invalid request');
  }
});

test('run-command requires --experimental for storage cp media copies', async (t) => {
  const scratch = await mkdtemp('backup-run-command-experimental-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repoRoot = path.join(scratch, 'repo');
  const backupDir = path.join(scratch, 'backup');
  const mediaPath = 'author/audio.wav';
  const mediaDest = path.join(backupDir, 'media', mediaPath);

  const calls = [];
  const run = createRunner({
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const approved = await run({
    step: 'media',
    args: ['storage', 'cp', '--linked', '--experimental', `ss:///quiz-media/${mediaPath}`, mediaDest],
    cwd: repoRoot,
    output: mediaDest,
  });
  assert.equal(approved.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['storage', 'cp', '--linked', '--experimental', `ss:///quiz-media/${mediaPath}`, mediaDest]);

  calls.length = 0;
  const missing = await run({
    step: 'media',
    args: ['storage', 'cp', '--linked', `ss:///quiz-media/${mediaPath}`, mediaDest],
    cwd: repoRoot,
    output: mediaDest,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'INVALID_ARGUMENTS');
  assert.equal(calls.length, 0);
});

test('run-command fails safe for missing executable and nonzero output, redacting all token shapes', async (t) => {
  const scratch = await mkdtemp('backup-run-command-errors-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const missingRun = createRunner({
    spawn: () => ({
      error: { code: 'ENOENT', message: `missing ${tokens[0]}` },
      status: null,
      stdout: '',
      stderr: '',
    }),
  });
  const missing = await missingRun({ step: 'version', args: ['--version'], cwd: scratch });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'ENOENT');
  assert.equal(tokens.some((token) => JSON.stringify(missing).includes(token)), false);

  const nonzeroRun = createRunner({
    spawn: () => ({
      status: 1,
      stdout: tokens[2],
      stderr: tokens[3],
    }),
  });
  const nonzero = await nonzeroRun({ step: 'version', args: ['--version'], cwd: scratch });
  assert.equal(nonzero.ok, false);
  assert.equal(nonzero.code, 'NONZERO_EXIT');
  assert.equal(tokens.some((token) => JSON.stringify(nonzero).includes(token)), false);
});

function copyMediaSql({ includeSource = false, rows }) {
  const columns = ['storage_path', 'kind', 'mime_type', 'byte_size'];
  if (includeSource) columns.push('source');
  const header = `COPY public.media_assets (${columns.join(', ')}) FROM stdin;\n`;
  const body = rows.map((row) => row.join('\t')).join('\n');
  return `${header}${body}\n\\.\n`;
}

test('parseMediaRows handles current and future COPY schemas, escapes, NULL, malformed blocks, and ignores other tables', () => {
  const noSource = copyMediaSql({
    rows: [
      ['author/audio.wav', 'audio', 'audio/wav', '5'],
      ['author/image.webp', 'image', 'image/webp', '4'],
    ],
  });
  const noSourceRows = parseMediaRows(noSource);
  assert.equal(noSourceRows.length, 2);
  assert.deepEqual(noSourceRows[0], {
    storage_path: 'author/audio.wav',
    kind: 'audio',
    mime_type: 'audio/wav',
    byte_size: 5,
  });
  assert.equal(Object.hasOwn(noSourceRows[0], 'source'), false);
  assert.equal(noSourceRows[1].storage_path, 'author/image.webp');

  const future = copyMediaSql({
    includeSource: true,
    rows: [
      ['author/clip\\134name.wav', 'audio', 'audio/wav', '5', '\\N'],
      ['author/image.webp', 'image', 'image/webp', '4', 'battle'],
    ],
  });
  const futureRows = parseMediaRows(future);
  assert.equal(futureRows[0].storage_path, 'author/clip\\name.wav');
  assert.equal(futureRows[0].source, null);
  assert.equal(futureRows[1].source, 'battle');

  const quoted = `COPY "public"."media_assets" ("storage_path", "kind", "mime_type", "byte_size") FROM stdin;\nauthor/a\taudio\taudio/wav\t5\n\\.\n`;
  assert.equal(parseMediaRows(quoted)[0].storage_path, 'author/a');

  const otherBefore = `COPY public.notes (body) FROM stdin;\nnote body\n\\.\n${copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav', '5']] })}`;
  assert.equal(parseMediaRows(otherBefore).length, 1);

  assert.throws(() => parseMediaRows(''), /Missing public.media_assets COPY block/);
  assert.throws(() => parseMediaRows(`COPY public.media_assets (storage_path, kind, mime_type, byte_size) FROM stdin;\nauthor/audio.wav\taudio\taudio/wav\t5\n`), /Unterminated COPY block/);
  assert.throws(() => parseMediaRows(copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav']] })), /wrong number of fields/);
  assert.throws(() => parseMediaRows(copyMediaSql({ rows: [['author/audio.wav', 'audio', 'bad/bad', '5']] })), /mime_type is invalid/);
  assert.throws(() => parseMediaRows(copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav', '0']] })), /byte_size is invalid/);
  assert.throws(() => parseMediaRows(copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav', '5'], ['author/audio.wav', 'image', 'image/webp', '4']] })), /Duplicate storage_path/);
  assert.throws(() => parseMediaRows(`COPY public.media_assets (storage_path, kind, mime_type, byte_size) FROM stdin;\nauthor/a\taudio\taudio/wav\t5\n\\.\n${copyMediaSql({ rows: [['author/b', 'audio', 'audio/wav', '5']] })}`), /Duplicate public.media_assets COPY block/);
});

test('parseMediaRows rejects missing required columns and non-explicit COPY block', () => {
  assert.throws(() => parseMediaRows(`COPY public.media_assets FROM stdin;\nauthor/a\taudio\taudio/wav\t5\n\\.\n`), /must include explicit columns/);
  assert.throws(() => parseMediaRows(`COPY public.media_assets (storage_path, kind, mime_type) FROM stdin;\na\taudio\taudio/wav\n\\.\n`), /Missing required column in media_assets COPY: byte_size/);
});

function createSupabaseFake({ repoRoot, backupDir, dataSql, mediaContents = {}, failStep, wrongSizePath, symlinkPath }) {
  const calls = [];

  const runner = async (request) => {
    calls.push(request);

    if (request.step === failStep) {
      return { ok: false, stdout: '', stderr: '' };
    }

    if (request.step === 'version') {
      return { ok: true, stdout: '2.119.0\n', stderr: '' };
    }

    if (request.step === 'schema') {
      await fs.writeFile(request.output, 'CREATE TABLE fixture();\n');
      return { ok: true, stdout: '', stderr: '' };
    }

    if (request.step === 'data') {
      await fs.writeFile(request.output, dataSql);
      return { ok: true, stdout: '', stderr: '' };
    }

    const dest = request.output;
    await fs.mkdir(path.dirname(dest), { recursive: true });

    if (symlinkPath && request.args[4].slice('ss:///quiz-media/'.length) === symlinkPath) {
      const target = path.join(backupDir, 'outside-target');
      await fs.writeFile(target, 'outside');
      await fs.symlink(target, dest);
    } else {
      const storagePath = request.args[4].slice('ss:///quiz-media/'.length);
      const content = mediaContents[storagePath] ?? 'default';
      const bytes = wrongSizePath === storagePath ? content + '-wrong' : content;
      await fs.writeFile(dest, bytes);
    }

    return { ok: true, stdout: '', stderr: '' };
  };

  return { runner, calls };
}

test('collectSupabase uses exact CLI args and cwd, copies nonbattle rows, excludes battle, and never lists storage', async (t) => {
  const scratch = await mkdtemp('backup-supabase-collect-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repoRoot = path.join(scratch, 'repo');
  const backupDir = path.join(scratch, 'backup');

  const dataSql = copyMediaSql({
    includeSource: true,
    rows: [
      ['author/audio.wav', 'audio', 'audio/wav', '5', 'author'],
      ['author/image.webp', 'image', 'image/webp', '4', 'author'],
      ['author/random.webp', 'image', 'image/webp', '6', 'battle'],
    ],
  });

  const fake = createSupabaseFake({
    repoRoot,
    backupDir,
    dataSql,
    mediaContents: {
      'author/audio.wav': 'sound',
      'author/image.webp': 'webp',
    },
  });

  const result = await collectSupabase({ dir: backupDir, repoRoot, runner: fake.runner });

  assert.deepEqual(result.versions, { supabase: '2.119.0' });
  assert.equal(result.media.length, 2);
  assert.deepEqual(result.media.map((m) => m.storage_path).sort(), ['author/audio.wav', 'author/image.webp']);
  assert.equal(result.media.some((m) => m.source === 'battle'), false);

  assert.equal(await fs.readFile(path.join(backupDir, 'media', 'author', 'audio.wav'), 'utf8'), 'sound');
  assert.equal(await fs.readFile(path.join(backupDir, 'media', 'author', 'image.webp'), 'utf8'), 'webp');
  await assert.rejects(() => fs.access(path.join(backupDir, 'media', 'author', 'random.webp')));

  const versionCall = fake.calls.find((c) => c.step === 'version');
  assert.deepEqual(versionCall.args, ['--version']);
  assert.equal(versionCall.cwd, repoRoot);

  const schemaCall = fake.calls.find((c) => c.step === 'schema');
  assert.deepEqual(schemaCall.args, ['db', 'dump', '--linked', '--schema', 'public', '--file', path.join(backupDir, 'database', 'schema.sql')]);
  assert.equal(schemaCall.cwd, repoRoot);

  const dataCall = fake.calls.find((c) => c.step === 'data');
  assert.deepEqual(dataCall.args, ['db', 'dump', '--linked', '--schema', 'public', '--data-only', '--use-copy', '--file', path.join(backupDir, 'database', 'data.sql')]);
  assert.equal(dataCall.cwd, repoRoot);

  const mediaCalls = fake.calls.filter((c) => c.step === 'media');
  assert.equal(mediaCalls.length, 2);
  for (const call of mediaCalls) {
    assert.equal(call.args[0], 'storage');
    assert.equal(call.args[1], 'cp');
    assert.equal(call.args[2], '--linked');
    assert.equal(call.args[3], '--experimental');
    assert.ok(call.args[4].startsWith('ss:///quiz-media/'));
    assert.equal(call.args[5], path.join(backupDir, 'media', ...call.args[4].slice('ss:///quiz-media/'.length).split('/')));
    assert.equal(call.cwd, repoRoot);
  }
  assert.equal(fake.calls.some((c) => c.args.includes('ls')), false);
});

test('collectSupabase validates every nonbattle path before any media copy', async (t) => {
  const scratch = await mkdtemp('backup-supabase-path-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repoRoot = path.join(scratch, 'repo');
  const backupDir = path.join(scratch, 'backup');

  const dataSql = copyMediaSql({
    rows: [
      ['author/audio.wav', 'audio', 'audio/wav', '5'],
      ['/absolute/bad.wav', 'audio', 'audio/wav', '5'],
    ],
  });

  const fake = createSupabaseFake({ repoRoot, backupDir, dataSql, mediaContents: { 'author/audio.wav': 'sound' } });

  await assert.rejects(
    () => collectSupabase({ dir: backupDir, repoRoot, runner: fake.runner }),
    (error) => {
      assert.equal(error.step, 'media');
      return true;
    },
  );
  assert.equal(fake.calls.filter((c) => c.step === 'media').length, 0);
});

test('collectSupabase required command failures reject with database/media step and no unsafe copy', async (t) => {
  const scratch = await mkdtemp('backup-supabase-fail-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  for (const failStep of ['schema', 'data', 'media']) {
    const repoRoot = path.join(scratch, `repo-${failStep}`);
    const backupDir = path.join(scratch, `backup-${failStep}`);
    const dataSql = copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav', '5']] });
    const fake = createSupabaseFake({ repoRoot, backupDir, dataSql, mediaContents: { 'author/audio.wav': 'sound' }, failStep });
    const expectedStep = failStep === 'media' ? 'media' : 'database';

    await assert.rejects(
      () => collectSupabase({ dir: backupDir, repoRoot, runner: fake.runner }),
      (error) => {
        assert.equal(error.step, expectedStep);
        return true;
      },
    );

    if (failStep !== 'media') {
      assert.equal(fake.calls.filter((c) => c.step === 'media').length, 0);
    }
  }
});

test('collectSupabase wrong size and symlink fail safely with media step', async (t) => {
  const scratch = await mkdtemp('backup-supabase-guard-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  for (const kind of ['wrong-size', 'symlink']) {
    const repoRoot = path.join(scratch, `repo-${kind}`);
    const backupDir = path.join(scratch, `backup-${kind}`);
    const dataSql = copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav', '5']] });
    const fake = createSupabaseFake({
      repoRoot,
      backupDir,
      dataSql,
      mediaContents: { 'author/audio.wav': 'sound' },
      wrongSizePath: kind === 'wrong-size' ? 'author/audio.wav' : undefined,
      symlinkPath: kind === 'symlink' ? 'author/audio.wav' : undefined,
    });

    await assert.rejects(
      () => collectSupabase({ dir: backupDir, repoRoot, runner: fake.runner }),
      (error) => {
        assert.equal(error.step, 'media');
        return true;
      },
    );
  }
});

test('runBackup orchestrates fake exports, manifests a required failure, and keeps dry-run inert', async (t) => {
  const scratch = await mkdtemp('backup-orchestration-');
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));

  const repoRoot = path.join(scratch, 'repo');
  const originalsDir = path.join(scratch, 'originals');
  await fs.mkdir(repoRoot);
  await fs.mkdir(path.join(originalsDir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(originalsDir, 'nested', 'original song.wav'), 'sound');
  const now = () => new Date('2026-10-01T12:00:00Z');
  const gitCommit = 'a'.repeat(40);
  const dataSql = copyMediaSql({ rows: [['author/audio.wav', 'audio', 'audio/wav', '5']] });
  const config = roadmapConfig;
  const backupDir = (out) => path.join(out, 'brainstorm-backup-2026-10-01');
  const run = async (name, options = {}) => {
    const out = path.join(scratch, name);
    const fake = createSupabaseFake({ repoRoot, backupDir: backupDir(out), dataSql, mediaContents: { 'author/audio.wav': 'sound' }, failStep: options.failStep });
    const gate = options.gate ?? makeRoadmapFakeGate();
    const result = await runBackup({ out, repoRoot, originalsDir, now, gitCommit, runner: fake.runner, gate, config, includeOriginals: options.includeOriginals });
    return { result, out, fake, gate };
  };

  const { result, out, fake, gate } = await run('success');
  assert.equal(result.ok, true);
  assert.equal(result.manifest.gitCommit, gitCommit);
  assert.equal(result.manifest.versions.supabase, '2.119.0');
  assert.ok(result.manifest.files.some((file) => file.path === 'roadmap.json'));
  assert.ok(result.manifest.files.some((file) => file.path === 'RESTORE.md'));
  assert.equal(result.manifest.originals[0].copied, false);
  assert.equal((await verifyBackup(result.dir)).ok, true);
  assert.ok(fake.calls.length > 0);
  assert.ok(gate.calls.length > 0);
  await assert.rejects(() => fs.access(path.join(result.dir, 'originals', 'nested', 'original song.wav')));

  const copied = await run('copy-originals', { includeOriginals: true });
  assert.equal(copied.result.ok, true);
  assert.equal(copied.result.manifest.originals[0].copied, true);
  assert.equal(await fs.readFile(path.join(copied.result.dir, 'originals', 'nested', 'original song.wav'), 'utf8'), 'sound');

  const failed = await run('schema-failure', { failStep: 'schema' });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.manifest.status, 'failed');
  assert.equal(failed.result.manifest.steps.database.status, 'failed');
  assert.equal(failed.result.manifest.steps.integrity.required, true);
  assert.equal((await verifyBackup(failed.result.dir)).ok, false);

  const manifestBefore = await fs.readFile(path.join(result.dir, 'MANIFEST.json'));
  const duplicate = await runBackup({ out, repoRoot, originalsDir, now, gitCommit, runner: fake.runner, gate, config });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'DESTINATION_EXISTS');
  assert.deepEqual(await fs.readFile(path.join(result.dir, 'MANIFEST.json')), manifestBefore);

  const dryOut = path.join(scratch, 'dry-run');
  let calls = 0;
  const forbidden = async () => { calls += 1; throw new Error('must not be called'); };
  const dryRun = await runBackup({
    out: dryOut,
    repoRoot,
    originalsDir: path.join(scratch, 'missing originals'),
    now,
    dryRun: true,
    runner: forbidden,
    gate: { read: forbidden },
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(calls, 0);
  await assert.rejects(() => fs.access(dryOut));
});
