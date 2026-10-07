import fs from 'node:fs/promises';
import path from 'node:path';

const ALLOWED_KINDS = new Set(['audio', 'image', 'video']);
const ALLOWED_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
]);
const MAX_MEDIA_BYTES = 26214400;

function backupError(step, message) {
  const error = new Error(message);
  error.step = step;
  return error;
}

function decodeField(value) {
  if (value === '\\N') return null;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    i += 1;
    if (i >= value.length) {
      out += '\\';
      break;
    }
    const next = value[i];
    if (next === '\\') out += '\\';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'v') out += '\v';
    else if (next >= '0' && next <= '7') {
      let oct = next;
      let count = 1;
      while (count < 3 && i + 1 < value.length && value[i + 1] >= '0' && value[i + 1] <= '7') {
        i += 1;
        oct += value[i];
        count += 1;
      }
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      out += '\\' + next;
    }
    i += 1;
  }
  return out;
}

function unquoteIdentifier(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value;
}

function parseQualifiedName(raw) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '.' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => unquoteIdentifier(part).toLowerCase());
}

function isMediaAssetsTable(tableRaw) {
  const parts = parseQualifiedName(tableRaw);
  return parts.length >= 2 && parts[parts.length - 1] === 'media_assets' && parts[parts.length - 2] === 'public';
}

function parseColumns(columnsRaw) {
  const columns = columnsRaw.split(',').map((column) => column.trim());
  if (columns.some((column) => column === '')) {
    throw new Error('Invalid empty identifier in media_assets COPY column list');
  }
  return columns.map((column) => unquoteIdentifier(column).toLowerCase());
}

function parseCopyHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.toUpperCase().startsWith('COPY ')) return null;
  const lower = trimmed.toLowerCase();
  if (!lower.includes(' from stdin;')) return null;
  if (!trimmed.endsWith(';')) return null;
  const afterCopy = trimmed.slice(5).trim();
  const fromPos = afterCopy.toLowerCase().indexOf(' from stdin;');
  if (fromPos === -1) return null;
  const beforeFrom = afterCopy.slice(0, fromPos).trim();
  const openParen = beforeFrom.indexOf('(');
  let tableRaw;
  let columnsRaw;
  if (openParen === -1) {
    tableRaw = beforeFrom;
    columnsRaw = undefined;
  } else {
    tableRaw = beforeFrom.slice(0, openParen).trim();
    const closeParen = beforeFrom.lastIndexOf(')');
    if (closeParen === -1) return null;
    columnsRaw = beforeFrom.slice(openParen + 1, closeParen);
  }
  if (!tableRaw || (openParen !== -1 && columnsRaw === undefined)) return null;
  return { tableRaw, columnsRaw };
}

export function parseMediaRows(dataSql) {
  if (typeof dataSql !== 'string') {
    throw new Error('dataSql must be a string');
  }

  const lines = dataSql.split(/\r?\n/);
  let inCopy = false;
  let currentCopy = null;
  let targetBlockFound = false;
  let targetBlockComplete = false;
  let targetColumns = null;
  let targetRows = null;

  for (const line of lines) {
    if (!inCopy) {
      const header = parseCopyHeader(line);
      if (!header) continue;

      if (isMediaAssetsTable(header.tableRaw)) {
        if (targetBlockFound) {
          throw new Error('Duplicate public.media_assets COPY block');
        }
        if (header.columnsRaw === undefined) {
          throw new Error('public.media_assets COPY block must include explicit columns');
        }
        const columns = parseColumns(header.columnsRaw);
        const required = ['storage_path', 'kind', 'mime_type', 'byte_size'];
        for (const column of required) {
          if (!columns.includes(column)) {
            throw new Error(`Missing required column in media_assets COPY: ${column}`);
          }
        }
        if (new Set(columns).size !== columns.length) {
          throw new Error('Duplicate column in media_assets COPY list');
        }
        targetBlockFound = true;
        targetBlockComplete = false;
        targetColumns = columns;
        targetRows = [];
        currentCopy = { target: true };
      } else {
        currentCopy = { target: false };
      }
      inCopy = true;
      continue;
    }

    const terminator = line.trim();
    if (terminator === '\\' + '.') {
      if (currentCopy?.target) {
        targetBlockComplete = true;
      }
      inCopy = false;
      currentCopy = null;
      continue;
    }

    if (currentCopy?.target) {
      targetRows.push(line);
    }
  }

  if (inCopy) {
    throw new Error('Unterminated COPY block');
  }
  if (!targetBlockFound) {
    throw new Error('Missing public.media_assets COPY block');
  }
  if (!targetBlockComplete) {
    throw new Error('Unterminated public.media_assets COPY block');
  }

  const requiredIndex = {
    storage_path: targetColumns.indexOf('storage_path'),
    kind: targetColumns.indexOf('kind'),
    mime_type: targetColumns.indexOf('mime_type'),
    byte_size: targetColumns.indexOf('byte_size'),
  };
  for (const [column, index] of Object.entries(requiredIndex)) {
    if (index === -1) {
      throw new Error(`Missing required column in media_assets COPY: ${column}`);
    }
  }
  const sourceIndex = targetColumns.indexOf('source');

  const rows = [];
  const seenStoragePaths = new Set();

  for (const rawLine of targetRows) {
    const fields = rawLine.split('\t');
    if (fields.length !== targetColumns.length) {
      throw new Error('media_assets data row has wrong number of fields');
    }

    const storagePath = decodeField(fields[requiredIndex.storage_path]);
    const kind = decodeField(fields[requiredIndex.kind]);
    const mimeType = decodeField(fields[requiredIndex.mime_type]);
    const rawByteSize = fields[requiredIndex.byte_size];
    const byteSizeValue = rawByteSize === '\\N' ? null : decodeField(rawByteSize);

    if (storagePath === null || typeof storagePath !== 'string' || storagePath.length === 0) {
      throw new Error('media_assets storage_path is required');
    }
    if (kind === null || typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) {
      throw new Error('media_assets kind is invalid');
    }
    if (mimeType === null || typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error('media_assets mime_type is invalid');
    }
    if (byteSizeValue === null) {
      throw new Error('media_assets byte_size is required');
    }
    const byteSize = Number(byteSizeValue);
    if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_MEDIA_BYTES) {
      throw new Error('media_assets byte_size is invalid');
    }

    if (seenStoragePaths.has(storagePath)) {
      throw new Error('Duplicate storage_path in media_assets');
    }
    seenStoragePaths.add(storagePath);

    const row = {
      storage_path: storagePath,
      kind,
      mime_type: mimeType,
      byte_size: byteSize,
    };
    if (sourceIndex !== -1) {
      const rawSource = fields[sourceIndex];
      row.source = rawSource === '\\N' ? null : decodeField(rawSource);
    }
    rows.push(row);
  }

  return rows;
}

function isSafeRelativeStoragePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/')) return false;
  const normalized = path.posix.normalize(value);
  if (normalized !== value) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function isPathContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function verifyRegularFile(filePath, step, message) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw backupError(step, message);
    }
  } catch (error) {
    if (error && error.step) throw error;
    throw backupError(step, message);
  }
}

export async function collectSupabase({ dir, repoRoot, runner }) {
  if (typeof dir !== 'string' || typeof repoRoot !== 'string' || typeof runner !== 'function') {
    throw new Error('collectSupabase requires dir, repoRoot, and runner');
  }

  const absDir = path.resolve(dir);
  const absRepoRoot = path.resolve(repoRoot);
  const databaseDir = path.join(absDir, 'database');
  const mediaRoot = path.join(absDir, 'media');
  const schemaDest = path.join(databaseDir, 'schema.sql');
  const dataDest = path.join(databaseDir, 'data.sql');

  await fs.mkdir(databaseDir, { recursive: true });

  let versionResult;
  try {
    versionResult = await runner({ step: 'version', args: ['--version'], cwd: absRepoRoot });
  } catch {
    throw backupError('database', 'Supabase version check failed');
  }
  if (!versionResult?.ok) {
    throw backupError('database', 'Supabase version check failed');
  }
  const supabaseVersion = String(versionResult.stdout ?? '').trim();
  if (!supabaseVersion) {
    throw backupError('database', 'Supabase version check failed');
  }

  let schemaResult;
  try {
    schemaResult = await runner({
      step: 'schema',
      args: ['db', 'dump', '--linked', '--schema', 'public', '--file', schemaDest],
      cwd: absRepoRoot,
      output: schemaDest,
    });
  } catch {
    throw backupError('database', 'Supabase schema dump failed');
  }
  if (!schemaResult?.ok) {
    throw backupError('database', 'Supabase schema dump failed');
  }
  await verifyRegularFile(schemaDest, 'database', 'Supabase schema dump failed');

  let dataResult;
  try {
    dataResult = await runner({
      step: 'data',
      args: ['db', 'dump', '--linked', '--schema', 'public', '--data-only', '--use-copy', '--file', dataDest],
      cwd: absRepoRoot,
      output: dataDest,
    });
  } catch {
    throw backupError('database', 'Supabase data dump failed');
  }
  if (!dataResult?.ok) {
    throw backupError('database', 'Supabase data dump failed');
  }
  await verifyRegularFile(dataDest, 'database', 'Supabase data dump failed');

  let dataSql;
  try {
    dataSql = await fs.readFile(dataDest, 'utf8');
  } catch {
    throw backupError('database', 'Supabase data file unreadable');
  }

  let parsedRows;
  try {
    parsedRows = parseMediaRows(dataSql);
  } catch {
    throw backupError('database', 'Supabase media catalog invalid');
  }

  const mediaToCopy = [];
  const seenPaths = new Set();
  for (const row of parsedRows) {
    if (seenPaths.has(row.storage_path)) {
      throw backupError('media', 'Invalid media catalog path');
    }
    seenPaths.add(row.storage_path);

    const isBattle = Object.prototype.hasOwnProperty.call(row, 'source') && row.source === 'battle';
    if (isBattle) continue;

    if (!isSafeRelativeStoragePath(row.storage_path)) {
      throw backupError('media', 'Invalid media catalog path');
    }
    if (!ALLOWED_KINDS.has(row.kind)) {
      throw backupError('media', 'Invalid media catalog path');
    }
    if (!ALLOWED_MIME_TYPES.has(row.mime_type)) {
      throw backupError('media', 'Invalid media catalog path');
    }
    if (!Number.isInteger(row.byte_size) || row.byte_size <= 0 || row.byte_size > MAX_MEDIA_BYTES) {
      throw backupError('media', 'Invalid media catalog path');
    }

    mediaToCopy.push(row);
  }

  if (mediaToCopy.length > 0) {
    await fs.mkdir(mediaRoot, { recursive: true });
  }

  const mediaInventory = [];
  for (const row of mediaToCopy) {
    const destination = path.join(mediaRoot, ...row.storage_path.split('/'));
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });

    const args = [
      'storage',
      'cp',
      '--linked',
      '--experimental',
      `ss:///quiz-media/${row.storage_path}`,
      destination,
    ];

    let copyResult;
    try {
      copyResult = await runner({
        step: 'media',
        args,
        cwd: absRepoRoot,
        output: destination,
      });
    } catch {
      throw backupError('media', 'Media copy failed');
    }
    if (!copyResult?.ok) {
      throw backupError('media', 'Media copy failed');
    }

    await verifyRegularFile(destination, 'media', 'Media copy failed');
    const stat = await fs.lstat(destination);
    if (stat.size !== row.byte_size) {
      throw backupError('media', 'Media size mismatch');
    }

    const realDestination = await fs.realpath(destination);
    const realMediaRoot = await fs.realpath(mediaRoot);
    if (!isPathContained(realMediaRoot, realDestination)) {
      throw backupError('media', 'Media path escaped backup directory');
    }

    const mediaEntry = {
      storage_path: row.storage_path,
      kind: row.kind,
      mime_type: row.mime_type,
      byte_size: row.byte_size,
    };
    if (Object.prototype.hasOwnProperty.call(row, 'source')) {
      mediaEntry.source = row.source;
    }
    mediaInventory.push(mediaEntry);
  }

  return {
    versions: { supabase: supabaseVersion },
    media: mediaInventory,
  };
}
