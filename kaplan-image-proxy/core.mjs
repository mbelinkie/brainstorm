import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_PROJECT = 'quiz-platform-image-generation';
const PROJECT_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const LOCATIONS = new Set(['global', 'us', 'eu']);
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'SPII',
  'RECITATION',
  'BLOCKLIST'
]);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LOCATION_MICRO_USD = { global: 67200, us: 73920, eu: 73920 };

export function readConfig(env = process.env) {
  const source = env === undefined ? process.env : (env && typeof env === 'object' ? env : {});

  const projectRaw = source.GOOGLE_CLOUD_PROJECT;
  let project = DEFAULT_PROJECT;
  if (projectRaw !== undefined) {
    if (typeof projectRaw !== 'string' || !PROJECT_RE.test(projectRaw)) {
      throw new Error('Invalid GOOGLE_CLOUD_PROJECT: must match project-id pattern');
    }
    project = projectRaw;
  }

  const location = source.VERTEX_LOCATION;
  if (location === undefined || location === null || location === '') {
    throw new Error('VERTEX_LOCATION is required');
  }
  if (!LOCATIONS.has(location)) {
    throw new Error('Invalid VERTEX_LOCATION: expected one of global, us, eu');
  }

  const sharedSecret = source.PROXY_SHARED_SECRET;
  if (typeof sharedSecret !== 'string' || sharedSecret.trim() === '' || sharedSecret.length === 0) {
    throw new Error('PROXY_SHARED_SECRET is required and must not be blank');
  }

  const portRaw = source.PORT;
  let port = 8080;
  if (portRaw !== undefined) {
    let parsed;
    let valid = false;
    if (typeof portRaw === 'number') {
      valid = Number.isInteger(portRaw);
      parsed = portRaw;
    } else if (typeof portRaw === 'string' && /^[0-9]+$/.test(portRaw)) {
      parsed = Number(portRaw);
      valid = Number.isInteger(parsed);
    }
    if (!valid || parsed < 1 || parsed > 65535) {
      throw new Error('Invalid PORT: must be a decimal integer between 1 and 65535');
    }
    port = parsed;
  }

  return { project, location, sharedSecret, port };
}

export function buildVertexRequest(input, config) {
  const prompt = input.prompt;
  const project = config.project;
  const location = config.location;
  const baseHost = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  const url = `https://${baseHost}/v1/projects/${project}/locations/${location}/publishers/google/models/gemini-3.1-flash-image:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      candidateCount: 1,
      responseModalities: ['TEXT', 'IMAGE'],
      responseFormat: [
        { image: { delivery: 'INLINE', imageSize: 'IMAGE_SIZE_ONE_K' } }
      ]
    }
  };
  return { url, body };
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function hasSafetySignal(body) {
  if (body && typeof body === 'object' && body.promptFeedback && typeof body.promptFeedback.blockReason === 'string' && body.promptFeedback.blockReason.length > 0) {
    return true;
  }
  if (!Array.isArray(body && body.candidates)) return false;
  return body.candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return typeof candidate.finishReason === 'string' && SAFETY_FINISH_REASONS.has(candidate.finishReason);
  });
}

export function parseVertexResponse(body) {
  const images = [];
  const candidates = Array.isArray(body && body.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const parts = Array.isArray(candidate.content && candidate.content.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.thought === true) continue;
      const inlineData = part.inlineData;
      if (!inlineData || typeof inlineData !== 'object') continue;
      const mimeType = inlineData.mimeType;
      const data = inlineData.data;
      if (!ALLOWED_MIME_TYPES.has(mimeType)) continue;
      if (!isCanonicalBase64(data)) continue;
      images.push({ mimeType, bytesBase64: data });
    }
  }
  if (images.length > 0) {
    return { images, blocked: false, blockReason: null };
  }
  if (hasSafetySignal(body)) {
    return { images: [], blocked: true, blockReason: 'SAFETY' };
  }
  const error = new Error('No images returned');
  error.code = 'NO_IMAGES';
  throw error;
}

export function estimateCostUsd(imageCount, location) {
  if (!Number.isInteger(imageCount) || imageCount < 0) {
    throw new TypeError('imageCount must be a non-negative integer');
  }
  if (location !== 'global' && location !== 'us' && location !== 'eu') {
    throw new Error('Invalid VERTEX_LOCATION: expected one of global, us, eu');
  }
  const micro = LOCATION_MICRO_USD[location];
  return (imageCount * micro) / 1e6;
}

function isAuthorized(headers, secret) {
  if (!headers || typeof headers !== 'object') return false;
  if (typeof secret !== 'string') return false;
  const authorization = headers['authorization'];
  if (typeof authorization !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return false;
  const provided = authorization.slice(prefix.length);
  const providedDigest = createHash('sha256').update(provided).digest();
  const secretDigest = createHash('sha256').update(secret).digest();
  return timingSafeEqual(providedDigest, secretDigest);
}

function isValidBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== 3 || !keys.includes('prompt') || !keys.includes('model') || !keys.includes('variants')) return false;
  const prompt = body.prompt;
  const model = body.model;
  const variants = body.variants;
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 2000) return false;
  if (model !== 'gemini-3.1-flash-image') return false;
  if (!Number.isInteger(variants) || variants < 1 || variants > 4) return false;
  return true;
}

function errorResponse(status, code, message) {
  return { status, body: { error: { code, message } } };
}

function sanitizeProviderError(error) {
  let code = 'VERTEX_ERROR';
  let message = 'Image generation failed';
  if (error && error.code === 'TOKEN_ERROR') {
    code = 'TOKEN_ERROR';
    message = 'Token fetch failed';
  } else if (error && error.code === 'NO_IMAGES') {
    code = 'NO_IMAGES';
    message = 'No images returned';
  }
  return { status: 502, body: { error: { code, message } } };
}

export async function handleRequest(request, { config, generate }) {
  const method = request && request.method;
  const path = request && request.path;
  const headers = request && request.headers;
  const body = request && request.body;
  if (path !== '/generate') {
    return errorResponse(404, 'NOT_FOUND', 'Not found');
  }
  if (method !== 'POST') {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  }
  if (!isAuthorized(headers, config.sharedSecret)) {
    return errorResponse(401, 'UNAUTHORIZED', 'Unauthorized');
  }
  if (!isValidBody(body)) {
    return errorResponse(400, 'BAD_REQUEST', 'Invalid request body');
  }
  const input = {
    prompt: body.prompt,
    model: body.model,
    variants: body.variants
  };
  try {
    const result = await generate(input);
    return { status: 200, body: result };
  } catch (error) {
    return sanitizeProviderError(error);
  }
}
