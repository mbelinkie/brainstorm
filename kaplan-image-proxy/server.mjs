import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { handleRequest, readConfig } from './core.mjs';
import { createVertexClient } from './vertex.mjs';

const MAX_BODY_BYTES = 65536;

function isAuthorized(headers, secret) {
  if (typeof secret !== 'string') return false;
  const authorization = headers && typeof headers === 'object'
    ? headers['authorization']
    : undefined;
  if (typeof authorization !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return false;
  const provided = authorization.slice(prefix.length);
  const providedDigest = createHash('sha256').update(provided).digest();
  const secretDigest = createHash('sha256').update(secret).digest();
  return timingSafeEqual(providedDigest, secretDigest);
}

function isJsonContentType(req) {
  const value = req.headers['content-type'];
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        cleanup();
        req.on('error', () => {});
        const error = new Error('Payload too large');
        error.status = 413;
        error.code = 'PAYLOAD_TOO_LARGE';
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error('Failed to read request body');
      error.status = 400;
      error.code = 'BAD_REQUEST';
      error.cause = err;
      reject(error);
    };

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function getPathname(req) {
  const raw = req.url || '';
  const queryIndex = raw.indexOf('?');
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  return path || '/';
}

export function createProxyServer({ config, generate, fetchImpl }) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('config object is required');
  }

  const generateImpl = typeof generate === 'function'
    ? generate
    : createVertexClient({ config, fetchImpl }).generate;

  const server = createServer(async (req, res) => {
    try {
      const path = getPathname(req);
      if (path !== '/generate') {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
        return;
      }

      if (!isAuthorized(req.headers, config.sharedSecret)) {
        sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
        return;
      }

      if (!isJsonContentType(req)) {
        sendJson(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
        return;
      }

      let body;
      try {
        const raw = await readBody(req, MAX_BODY_BYTES);
        try {
          body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
          return;
        }
      } catch (error) {
        if (error && error.status === 413) {
          sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 65536 bytes' } });
        } else {
          sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Unable to read request body' } });
        }
        return;
      }

      const request = {
        method: req.method,
        path,
        headers: req.headers,
        body
      };

      const result = await handleRequest(request, { config, generate: generateImpl });
      sendJson(res, result.status, result.body);
    } catch (error) {
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  return server;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    const config = readConfig(process.env);
    const server = createProxyServer({ config });
    server.on('error', (error) => {
      console.error(error && error.message ? error.message : 'Server failed to start');
      process.exitCode = 1;
    });
    server.listen(config.port, '0.0.0.0');
  } catch (error) {
    console.error(error && error.message ? error.message : 'Invalid configuration');
    process.exitCode = 1;
  }
}
