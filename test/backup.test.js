import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  assertOutsideRepo,
  scanSecrets,
  inventoryOriginals,
  writeManifest,
  verifyBackup,
} from '../scripts/backup/files.mjs';

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
