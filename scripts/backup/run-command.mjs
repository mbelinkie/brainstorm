import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { scanSecrets } from './files.mjs';

const SUPABASE_COMMAND = 'supabase';

const OS_ENV_ALLOWLIST = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
]);

function buildChildEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isSafeStoragePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/')) return false;
  const normalized = path.posix.normalize(value);
  if (normalized !== value) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function redactSecrets(text) {
  if (text == null) return '';
  let out = String(text);
  out = out.replace(/ghp_[A-Za-z0-9]{20,}/g, '[redacted]');
  out = out.replace(/github_pat_[A-Za-z0-9_]{10,}/g, '[redacted]');
  out = out.replace(/sb_secret_[A-Za-z0-9]{10,}/g, '[redacted]');
  out = out.replace(/([A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+)/g, (match) =>
    scanSecrets(match) ? '[redacted]' : match,
  );
  if (scanSecrets(out)) return '';
  return out;
}

function exactArgs(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((item, index) => typeof item === 'string' && item === expected[index]);
}

function isSafeAbsoluteLocalPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!path.isAbsolute(value)) return false;
  if (value.includes('\0')) return false;
  const normalized = path.normalize(value);
  if (normalized !== value) return false;
  const parts = value.split(path.sep).filter(Boolean);
  return parts.every((part) => part !== '..');
}

function hasLocalSuffix(destination, ...relativeParts) {
  return destination.endsWith(path.sep + path.join(...relativeParts));
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    return { ok: false, code: 'INVALID_REQUEST' };
  }

  const allowedKeys = new Set(['step', 'args', 'cwd', 'output']);
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: 'INVALID_REQUEST' };
    }
  }

  const { step, args, cwd, output } = request;

  if (typeof step !== 'string' || !['version', 'schema', 'data', 'media'].includes(step)) {
    return { ok: false, code: 'INVALID_STEP' };
  }

  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, code: 'INVALID_CWD' };
  }

  if (step === 'version') {
    if (output !== undefined && output !== null) {
      return { ok: false, code: 'INVALID_OUTPUT' };
    }
    if (!exactArgs(args, ['--version'])) {
      return { ok: false, code: 'INVALID_ARGUMENTS' };
    }
    return { ok: true, step, args: ['--version'], cwd, output: undefined };
  }

  if (step === 'schema') {
    if (!Array.isArray(args) || args.length !== 7) {
      return { ok: false, code: 'INVALID_ARGUMENTS' };
    }
    const expectedPrefix = ['db', 'dump', '--linked', '--schema', 'public', '--file'];
    for (let i = 0; i < expectedPrefix.length; i += 1) {
      if (typeof args[i] !== 'string' || args[i] !== expectedPrefix[i]) {
        return { ok: false, code: 'INVALID_ARGUMENTS' };
      }
    }
    const destination = args[6];
    if (!isSafeAbsoluteLocalPath(destination) || !hasLocalSuffix(destination, 'database', 'schema.sql')) {
      return { ok: false, code: 'INVALID_ARGUMENTS' };
    }
    if (output !== undefined && output !== null && output !== destination) {
      return { ok: false, code: 'INVALID_OUTPUT' };
    }
    return {
      ok: true,
      step,
      args,
      cwd,
      output: output === undefined || output === null ? destination : output,
    };
  }

  if (step === 'data') {
    if (!Array.isArray(args) || args.length !== 9) {
      return { ok: false, code: 'INVALID_ARGUMENTS' };
    }
    const expectedPrefix = ['db', 'dump', '--linked', '--schema', 'public', '--data-only', '--use-copy', '--file'];
    for (let i = 0; i < expectedPrefix.length; i += 1) {
      if (typeof args[i] !== 'string' || args[i] !== expectedPrefix[i]) {
        return { ok: false, code: 'INVALID_ARGUMENTS' };
      }
    }
    const destination = args[8];
    if (!isSafeAbsoluteLocalPath(destination) || !hasLocalSuffix(destination, 'database', 'data.sql')) {
      return { ok: false, code: 'INVALID_ARGUMENTS' };
    }
    if (output !== undefined && output !== null && output !== destination) {
      return { ok: false, code: 'INVALID_OUTPUT' };
    }
    return {
      ok: true,
      step,
      args,
      cwd,
      output: output === undefined || output === null ? destination : output,
    };
  }

  // step === 'media'
  if (!Array.isArray(args) || args.length !== 5) {
    return { ok: false, code: 'INVALID_ARGUMENTS' };
  }
  if (args[0] !== 'storage' || args[1] !== 'cp' || args[2] !== '--linked') {
    return { ok: false, code: 'INVALID_ARGUMENTS' };
  }
  const prefix = 'ss:///quiz-media/';
  if (typeof args[3] !== 'string' || !args[3].startsWith(prefix)) {
    return { ok: false, code: 'INVALID_STORAGE_PATH' };
  }
  const storagePath = args[3].slice(prefix.length);
  if (!isSafeStoragePath(storagePath)) {
    return { ok: false, code: 'INVALID_STORAGE_PATH' };
  }
  const destination = args[4];
  if (!isSafeAbsoluteLocalPath(destination) || !hasLocalSuffix(destination, 'media', storagePath)) {
    return { ok: false, code: 'INVALID_ARGUMENTS' };
  }
  if (output !== undefined && output !== null && output !== destination) {
    return { ok: false, code: 'INVALID_OUTPUT' };
  }
  return {
    ok: true,
    step,
    args,
    cwd,
    output: output === undefined || output === null ? destination : output,
  };
}

export function createRunner({ spawn } = {}) {
  const spawnRunner = spawn || spawnSync;

  return async function run(request) {
    const validation = validateRequest(request);
    if (!validation.ok) {
      return { ok: false, code: validation.code, stdout: '', stderr: '' };
    }

    const { args, cwd } = validation;
    let result;

    try {
      result = spawnRunner(SUPABASE_COMMAND, args, {
        shell: false,
        cwd,
        env: buildChildEnv(),
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return { ok: false, code: 'SPAWN_ERROR', stdout: '', stderr: '' };
    }

    const errorCode = result?.error?.code;
    const status = result?.status ?? null;
    const stdout = redactSecrets(result?.stdout);
    const stderr = redactSecrets(result?.stderr);

    if (!result?.error && status === 0) {
      return { ok: true, code: 0, stdout, stderr };
    }

    return {
      ok: false,
      code: errorCode || 'NONZERO_EXIT',
      stdout,
      stderr,
    };
  };
}
