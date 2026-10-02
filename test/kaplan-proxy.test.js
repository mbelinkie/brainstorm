import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readConfig,
  buildVertexRequest,
  parseVertexResponse,
  estimateCostUsd,
  handleRequest
} from '../kaplan-image-proxy/core.mjs';
import { createVertexClient } from '../kaplan-image-proxy/vertex.mjs';
import { createProxyServer } from '../kaplan-image-proxy/server.mjs';

const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const DEFAULT_PROJECT = 'quiz-platform-image-generation';
const BASE_CONFIG = {
  project: DEFAULT_PROJECT,
  location: 'global',
  sharedSecret: 'SYNTHETIC_SECRET_SENTINEL',
  port: 8080
};
const SYNTHETIC_PROMPT = 'SYNTHETIC_PROMPT_SENTINEL';
const SYNTHETIC_SECRET = 'SYNTHETIC_SECRET_SENTINEL';
const SYNTHETIC_TOKEN = 'SYNTHETIC_TOKEN_SENTINEL';
const SYNTHETIC_RAW_ERROR = 'SYNTHETIC_RAW_ERROR_SENTINEL';
const GLOBAL_ONE_K_USD = 0.0672;
const NON_GLOBAL_ONE_K_USD = 0.07392;
const IMAGE_ONE = 'YQ==';
const IMAGE_TWO = 'Yg==';
const IMAGE_THREE = 'Yw==';
const IMAGE_FOUR = 'ZA==';
const FINAL_IMAGE_ONE = { mimeType: 'image/png', bytesBase64: IMAGE_ONE };
const FINAL_IMAGE_TWO = { mimeType: 'image/png', bytesBase64: IMAGE_TWO };
const FINAL_IMAGE_THREE = { mimeType: 'image/png', bytesBase64: IMAGE_THREE };
const FINAL_IMAGE_FOUR = { mimeType: 'image/png', bytesBase64: IMAGE_FOUR };
const FINAL_IMAGES = [FINAL_IMAGE_ONE, FINAL_IMAGE_TWO, FINAL_IMAGE_THREE, FINAL_IMAGE_FOUR];

function makeImagePart(data = IMAGE_ONE, mimeType = 'image/png') {
  return { inlineData: { mimeType, data } };
}

function makeVertexResponse(parts) {
  return { candidates: [{ content: { role: 'model', parts } }] };
}

function makeEmptyBody() {
  return { candidates: [{ content: { role: 'model', parts: [{ text: 'no image' }] } }] };
}

function makeSafetyBody() {
  return {
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [] } }]
  };
}

function validBody() {
  return { prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 1 };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function makeMetadataResponse({ ok = true, token = SYNTHETIC_TOKEN, tokenType = 'Bearer', jsonError = false } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => {
      if (jsonError) throw new Error('metadata json failure');
      return { access_token: token, token_type: tokenType };
    }
  };
}

function makeMetadataAndVertexFetch({ vertexImages = [], responseOverrides = [] } = {}) {
  const calls = [];
  let metadataCalls = 0;
  let vertexCalls = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === METADATA_URL) {
      metadataCalls += 1;
      return makeMetadataResponse();
    }
    if (url.includes(':generateContent')) {
      const index = vertexCalls;
      vertexCalls += 1;
      const override = responseOverrides[index] || null;
      if (override) {
        if (override.kind === 'status') {
          return { ok: false, status: override.status, json: async () => ({}) };
        }
        if (override.kind === 'jsonError') {
          return { ok: true, status: 200, json: async () => { throw new Error('vertex json failure'); } };
        }
        if (override.kind === 'error') {
          const error = new Error(override.message || 'vertex fetch failure');
          if (override.code) error.code = override.code;
          throw error;
        }
        if (override.kind === 'body') {
          return { ok: true, status: 200, json: async () => override.body };
        }
      }
      const data = vertexImages[index] || IMAGE_ONE;
      return { ok: true, status: 200, json: async () => makeVertexResponse([makeImagePart(data)]) };
    }
    throw new Error(`Unexpected external fetch: ${url}`);
  };
  fetchImpl.calls = calls;
  fetchImpl.metadataCallCount = () => metadataCalls;
  fetchImpl.vertexCallCount = () => vertexCalls;
  return fetchImpl;
}

function makeVertexOnlyFetch({ images = [], responseOverrides = [] } = {}) {
  const calls = [];
  let vertexCalls = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (!url.includes(':generateContent')) {
      throw new Error(`Unexpected external fetch: ${url}`);
    }
    const index = vertexCalls;
    vertexCalls += 1;
    const override = responseOverrides[index] || null;
    if (override) {
      if (override.kind === 'status') {
        return { ok: false, status: override.status, json: async () => ({}) };
      }
      if (override.kind === 'jsonError') {
        return { ok: true, status: 200, json: async () => { throw new Error('vertex json failure'); } };
      }
      if (override.kind === 'error') {
        const error = new Error(override.message || 'vertex fetch failure');
        if (override.code) error.code = override.code;
        throw error;
      }
      if (override.kind === 'body') {
        return { ok: true, status: 200, json: async () => override.body };
      }
    }
    const data = images[index] || IMAGE_ONE;
    return { ok: true, status: 200, json: async () => makeVertexResponse([makeImagePart(data)]) };
  };
  fetchImpl.calls = calls;
  fetchImpl.vertexCallCount = () => vertexCalls;
  return fetchImpl;
}

async function postJson(port, path, { method = 'POST', headers = {}, body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body
  });
}

// Core configuration

test('readConfig defaults project and port and preserves exact secret bytes', () => {
  const secret = '⟪synthetic-secret-💯⟫';
  const config = readConfig({ VERTEX_LOCATION: 'global', PROXY_SHARED_SECRET: secret });
  assert.deepEqual(config, {
    project: DEFAULT_PROJECT,
    location: 'global',
    sharedSecret: secret,
    port: 8080
  });
});

test('readConfig requires and validates explicit location, secret, and port', () => {
  assert.throws(
    () => readConfig({ PROXY_SHARED_SECRET: 'x' }),
    /VERTEX_LOCATION is required/
  );
  assert.throws(
    () => readConfig({ VERTEX_LOCATION: 'mars', PROXY_SHARED_SECRET: 'x' }),
    /Invalid VERTEX_LOCATION/
  );
  assert.throws(
    () => readConfig({ VERTEX_LOCATION: 'global' }),
    /PROXY_SHARED_SECRET is required/
  );
  assert.throws(
    () => readConfig({ VERTEX_LOCATION: 'global', PROXY_SHARED_SECRET: 'x', PORT: 'abc' }),
    /Invalid PORT/
  );
  assert.throws(
    () => readConfig({ VERTEX_LOCATION: 'global', PROXY_SHARED_SECRET: 'x', PORT: 0 }),
    /Invalid PORT/
  );
});

test('buildVertexRequest emits canonical fixed1K request for global', () => {
  const req = buildVertexRequest(
    { prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image' },
    BASE_CONFIG
  );
  assert.equal(
    req.url,
    'https://aiplatform.googleapis.com/v1/projects/quiz-platform-image-generation/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent'
  );
  assert.deepEqual(req.body, {
    contents: [{ role: 'user', parts: [{ text: SYNTHETIC_PROMPT }] }],
    generationConfig: {
      candidateCount: 1,
      responseModalities: ['TEXT', 'IMAGE'],
      responseFormat: [
        { image: { delivery: 'INLINE', imageSize: 'IMAGE_SIZE_ONE_K' } }
      ]
    }
  });
});

test('buildVertexRequest emits regional host for non-global', () => {
  const config = { ...BASE_CONFIG, location: 'us' };
  const req = buildVertexRequest(
    { prompt: 'p', model: 'gemini-3.1-flash-image' },
    config
  );
  assert.equal(
    req.url,
    'https://us-aiplatform.googleapis.com/v1/projects/quiz-platform-image-generation/locations/us/publishers/google/models/gemini-3.1-flash-image:generateContent'
  );
});

// Vertex response parsing

test('parseVertexResponse ignores text/fileData/thought/nonimage/malformed parts and preserves order', () => {
  const body = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { text: 'ignore me' },
            { fileData: { mimeType: 'image/png', fileUri: 'gs://bucket/object' } },
            { thought: true, inlineData: { mimeType: 'image/png', data: IMAGE_FOUR } },
            { inlineData: { mimeType: 'application/pdf', data: IMAGE_ONE } },
            { inlineData: { mimeType: 'image/png', data: IMAGE_ONE } },
            { inlineData: { mimeType: 'image/png', data: 'Zh==' } },
            { inlineData: { mimeType: 'image/png', data: IMAGE_TWO } }
          ]
        }
      }
    ]
  };
  const result = parseVertexResponse(body);
  assert.deepEqual(result.images, [
    { mimeType: 'image/png', bytesBase64: IMAGE_ONE },
    { mimeType: 'image/png', bytesBase64: IMAGE_TWO }
  ]);
  assert.equal(result.blocked, false);
  assert.equal(result.blockReason, null);
});

test('parseVertexResponse accepts canonical padded base64 variants and rejects noncanonical', () => {
  for (const data of ['Zg==', 'Zm8=', 'Zm9v']) {
    const result = parseVertexResponse({
      candidates: [{ content: { role: 'model', parts: [makeImagePart(data)] } }]
    });
    assert.deepEqual(result.images, [{ mimeType: 'image/png', bytesBase64: data }]);
  }
  for (const data of ['Zh==', 'Zm9=']) {
    assert.throws(
      () => parseVertexResponse({
        candidates: [{ content: { role: 'model', parts: [makeImagePart(data)] } }]
      }),
      (error) => error.code === 'NO_IMAGES'
    );
  }
});

test('parseVertexResponse maps safety to blocked when there are zero final images', () => {
  const result = parseVertexResponse(makeSafetyBody());
  assert.deepEqual(result, { images: [], blocked: true, blockReason: 'SAFETY' });

  const safetyFinishReasons = [
    'SAFETY',
    'IMAGE_SAFETY',
    'PROHIBITED_CONTENT',
    'SPII',
    'RECITATION',
    'BLOCKLIST',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
    'MODEL_ARMOR'
  ];
  for (const finishReason of safetyFinishReasons) {
    const body = {
      candidates: [{ finishReason, content: { role: 'model', parts: [] } }]
    };
    const parsed = parseVertexResponse(body);
    assert.deepEqual(parsed, { images: [], blocked: true, blockReason: 'SAFETY' }, finishReason);
  }

  for (const finishReason of ['IMAGE_OTHER', 'OTHER', 'NO_IMAGE']) {
    const body = {
      candidates: [{ finishReason, content: { role: 'model', parts: [] } }]
    };
    assert.throws(
      () => parseVertexResponse(body),
      (error) => error && error.code === 'NO_IMAGES',
      finishReason
    );
  }
});

test('actual loopback HTTP classifies added blocked image finish reasons as safety when zero images', async () => {
  const addedFinishReasons = ['IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'MODEL_ARMOR'];

  for (const finishReason of addedFinishReasons) {
    const candidateBody = {
      candidates: [{ finishReason, content: { role: 'model', parts: [] } }]
    };

    const fetchImpl = makeMetadataAndVertexFetch({
      responseOverrides: [{ kind: 'body', body: candidateBody }]
    });
    const server = createProxyServer({ config: BASE_CONFIG, fetchImpl });
    const port = await listen(server);

    try {
      const response = await postJson(port, '/generate', {
        headers: {
          Authorization: `Bearer ${BASE_CONFIG.sharedSecret}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(validBody())
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        images: [],
        costUsd: 0,
        blocked: true,
        blockReason: 'SAFETY',
        partial: false
      });
      assert.equal(fetchImpl.metadataCallCount(), 1);
      assert.equal(fetchImpl.vertexCallCount(), 1);
      assert.equal(fetchImpl.calls.length, 2);
    } finally {
      await close(server);
    }
  }
});

test('actual loopback HTTP preserves final-image override for added blocked image finish reasons', async () => {
  const addedFinishReasons = ['IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'MODEL_ARMOR'];

  for (const finishReason of addedFinishReasons) {
    const candidateBody = {
      candidates: [{ finishReason, content: { role: 'model', parts: [makeImagePart(IMAGE_ONE)] } }]
    };

    const fetchImpl = makeMetadataAndVertexFetch({
      responseOverrides: [{ kind: 'body', body: candidateBody }]
    });
    const server = createProxyServer({ config: BASE_CONFIG, fetchImpl });
    const port = await listen(server);

    try {
      const response = await postJson(port, '/generate', {
        headers: {
          Authorization: `Bearer ${BASE_CONFIG.sharedSecret}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(validBody())
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.blocked, false);
      assert.deepEqual(body.images, [FINAL_IMAGE_ONE]);
      assert.equal(fetchImpl.metadataCallCount(), 1);
      assert.equal(fetchImpl.vertexCallCount(), 1);
      assert.equal(fetchImpl.calls.length, 2);
    } finally {
      await close(server);
    }
  }
});

test('parseVertexResponse returns images with blocked false even when safety is present', () => {
  const body = {
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: [
      {
        finishReason: 'SAFETY',
        content: { role: 'model', parts: [makeImagePart(IMAGE_ONE)] }
      }
    ]
  };
  const result = parseVertexResponse(body);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].bytesBase64, IMAGE_ONE);
  assert.equal(result.blocked, false);
  assert.equal(result.blockReason, null);
});

test('parseVertexResponse throws NO_IMAGES for empty success without safety', () => {
  assert.throws(
    () => parseVertexResponse(makeEmptyBody()),
    (error) => error.code === 'NO_IMAGES'
  );
});

// Cost estimate

test('estimateCostUsd uses fixed 1K estimates for both price tiers', () => {
  assert.equal(estimateCostUsd(1, 'global'), GLOBAL_ONE_K_USD);
  assert.equal(estimateCostUsd(4, 'global'), 0.2688);
  assert.equal(estimateCostUsd(1, 'us'), NON_GLOBAL_ONE_K_USD);
  assert.equal(estimateCostUsd(1, 'eu'), NON_GLOBAL_ONE_K_USD);
  assert.equal(estimateCostUsd(4, 'us'), 0.29568);
  assert.equal(estimateCostUsd(4, 'eu'), 0.29568);
});

test('estimateCostUsd rejects invalid count and location', () => {
  assert.throws(() => estimateCostUsd(-1, 'global'), TypeError);
  assert.throws(() => estimateCostUsd(1.5, 'global'), TypeError);
  assert.throws(() => estimateCostUsd(1, 'mars'), /Invalid VERTEX_LOCATION/);
});

// Request handler

test('handleRequest authenticates exact secret and returns canonical generate result', async () => {
  const generate = async (input) => {
    assert.deepEqual(input, {
      prompt: SYNTHETIC_PROMPT,
      model: 'gemini-3.1-flash-image',
      variants: 2
    });
    return {
      images: [FINAL_IMAGE_ONE],
      costUsd: GLOBAL_ONE_K_USD,
      blocked: false,
      blockReason: null,
      partial: false
    };
  };
  const result = await handleRequest(
    {
      method: 'POST',
      path: '/generate',
      headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` },
      body: {
        prompt: SYNTHETIC_PROMPT,
        model: 'gemini-3.1-flash-image',
        variants: 2
      }
    },
    { config: BASE_CONFIG, generate }
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    images: [FINAL_IMAGE_ONE],
    costUsd: GLOBAL_ONE_K_USD,
    blocked: false,
    blockReason: null,
    partial: false
  });
});

test('handleRequest returns 401 before body validation and provider calls', async () => {
  let generateCalls = 0;
  const generate = async () => { generateCalls += 1; };
  const requests = [
    { method: 'POST', path: '/generate', headers: {}, body: validBody() },
    { method: 'POST', path: '/generate', headers: { authorization: 'Bearer wrong' }, body: validBody() },
    { method: 'POST', path: '/generate', headers: { authorization: 'Bearer ' }, body: validBody() },
    { method: 'POST', path: '/generate', headers: { authorization: 'Basic something' }, body: validBody() }
  ];
  for (const request of requests) {
    const result = await handleRequest(request, { config: BASE_CONFIG, generate });
    assert.equal(result.status, 401);
  }
  assert.equal(generateCalls, 0);
});

test('handleRequest returns 400 for invalid body and does not call provider', async () => {
  let generateCalls = 0;
  const generate = async () => { generateCalls += 1; };
  const invalidBodies = [
    null,
    [],
    { prompt: '', model: 'gemini-3.1-flash-image', variants: 1 },
    { prompt: SYNTHETIC_PROMPT, model: 'other', variants: 1 },
    { prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 0 },
    { prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 5 },
    { prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 1, extra: true },
    { prompt: 'x'.repeat(2001), model: 'gemini-3.1-flash-image', variants: 1 }
  ];
  for (const body of invalidBodies) {
    const result = await handleRequest({
      method: 'POST',
      path: '/generate',
      headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` },
      body
    }, { config: BASE_CONFIG, generate });
    assert.equal(result.status, 400);
  }
  assert.equal(generateCalls, 0);
});

test('handleRequest sanitizes provider errors to 502 without leaking raw sentinels', async () => {
  const generate = async () => {
    const error = new Error(SYNTHETIC_RAW_ERROR);
    error.code = 'VERTEX_ERROR';
    throw error;
  };
  const result = await handleRequest(
    {
      method: 'POST',
      path: '/generate',
      headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` },
      body: validBody()
    },
    { config: BASE_CONFIG, generate }
  );
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, 'VERTEX_ERROR');
  assert.equal(result.body.error.message, 'Image generation failed');
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes(SYNTHETIC_RAW_ERROR), false);
  assert.equal(serialized.includes(SYNTHETIC_SECRET), false);
  assert.equal(serialized.includes(SYNTHETIC_PROMPT), false);
  assert.equal(serialized.includes(SYNTHETIC_TOKEN), false);
});

// Vertex client with fake token and fetch sources

test('createVertexClient fetches token once and makes exactly variants sequential canonical POSTs', async () => {
  const fetchImpl = makeVertexOnlyFetch({ images: [IMAGE_ONE, IMAGE_TWO, IMAGE_THREE, IMAGE_FOUR] });
  const tokenCount = { count: 0 };
  const client = createVertexClient({
    config: BASE_CONFIG,
    fetchImpl,
    getAccessToken: async () => {
      tokenCount.count += 1;
      return SYNTHETIC_TOKEN;
    }
  });
  const result = await client.generate({
    prompt: SYNTHETIC_PROMPT,
    model: 'gemini-3.1-flash-image',
    variants: 4
  });

  assert.equal(tokenCount.count, 1);
  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(result.images, FINAL_IMAGES);
  assert.equal(result.costUsd, 0.2688);
  assert.equal(result.blocked, false);
  assert.equal(result.blockReason, null);
  assert.equal(result.partial, false);

  for (const call of fetchImpl.calls) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, `Bearer ${SYNTHETIC_TOKEN}`);
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(call.options.body);
    assert.deepEqual(
      body,
      buildVertexRequest(
        { prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image' },
        BASE_CONFIG
      ).body
    );
  }
});

test('createVertexClient returns correct image count and cost for 1..4 global variants', async () => {
  for (const variants of [1, 2, 3, 4]) {
    const fetchImpl = makeVertexOnlyFetch({ images: [IMAGE_ONE, IMAGE_TWO, IMAGE_THREE, IMAGE_FOUR] });
    const client = createVertexClient({
      config: BASE_CONFIG,
      fetchImpl,
      getAccessToken: async () => 'token'
    });
    const result = await client.generate({
      prompt: SYNTHETIC_PROMPT,
      model: 'gemini-3.1-flash-image',
      variants
    });
    assert.equal(result.images.length, variants);
    assert.equal(fetchImpl.vertexCallCount(), variants);
    assert.equal(fetchImpl.calls.length, variants);
    assert.equal(result.costUsd, variants * GLOBAL_ONE_K_USD);
    assert.equal(result.partial, false);
  }
});

test('createVertexClient uses non-global rate', async () => {
  const config = { ...BASE_CONFIG, location: 'us' };
  const fetchImpl = makeVertexOnlyFetch({ images: [IMAGE_ONE, IMAGE_TWO, IMAGE_THREE, IMAGE_FOUR] });
  const client = createVertexClient({ config, fetchImpl, getAccessToken: async () => 'token' });
  const result = await client.generate({ prompt: 'p', model: 'gemini-3.1-flash-image', variants: 4 });
  assert.equal(result.costUsd, 0.29568);
});

test('createVertexClient token source failure sanitizes TOKEN_ERROR and never calls Vertex', async () => {
  const fetchImpl = makeVertexOnlyFetch({ images: [] });
  const client = createVertexClient({
    config: BASE_CONFIG,
    fetchImpl,
    getAccessToken: async () => {
      throw new Error(SYNTHETIC_RAW_ERROR);
    }
  });
  await assert.rejects(
    () => client.generate({ prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 1 }),
    (error) => {
      assert.equal(error.code, 'TOKEN_ERROR');
      assert.equal(error.message.includes(SYNTHETIC_RAW_ERROR), false);
      return true;
    }
  );
  assert.equal(fetchImpl.vertexCallCount(), 0);
});

test('createVertexClient default metadata failures sanitize before Vertex', async () => {
  const scenarios = [
    { kind: 'status' },
    { kind: 'jsonError' },
    { kind: 'tokenType' },
    { kind: 'missingToken' }
  ];
  for (const scenario of scenarios) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url === METADATA_URL) {
        if (scenario.kind === 'status') return { ok: false, status: 500, json: async () => ({}) };
        if (scenario.kind === 'jsonError') {
          return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
        }
        if (scenario.kind === 'tokenType') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'tok', token_type: 'NotBearer' }) };
        }
        if (scenario.kind === 'missingToken') {
          return { ok: true, status: 200, json: async () => ({ token_type: 'Bearer' }) };
        }
      }
      throw new Error(`Unexpected Vertex call: ${url}`);
    };
    const client = createVertexClient({ config: BASE_CONFIG, fetchImpl });
    await assert.rejects(
      () => client.generate({ prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 1 }),
      (error) => {
        assert.equal(error.code, 'TOKEN_ERROR');
        assert.equal(error.message.includes(SYNTHETIC_RAW_ERROR), false);
        return true;
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, METADATA_URL);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.headers['Metadata-Flavor'], 'Google');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
  }
});

test('createVertexClient metadata body wait aborts after signal timeout without Vertex', { timeout: 15000 }, async () => {
  let vertexCalls = 0;
  let capturedSignal;
  const fetchImpl = async (url, options) => {
    if (url === METADATA_URL) {
      capturedSignal = options.signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
      };
    }
    vertexCalls += 1;
    throw new Error(`Unexpected Vertex call: ${url}`);
  };
  const client = createVertexClient({ config: BASE_CONFIG, fetchImpl });
  const started = Date.now();
  await assert.rejects(
    () => client.generate({ prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 1 }),
    (error) => {
      assert.equal(error.code, 'TOKEN_ERROR');
      assert.equal(error.message.includes('aborted'), false);
      return true;
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 9000, `elapsed ${elapsed} should be near 10s`);
  assert.equal(vertexCalls, 0);
  assert.ok(capturedSignal instanceof AbortSignal);
});

test('createVertexClient sanitizes Vertex HTTP/fetch/JSON failures to VERTEX_ERROR with no retries', async () => {
  const scenarios = [
    { kind: 'status', status: 400 },
    { kind: 'status', status: 401 },
    { kind: 'status', status: 429 },
    { kind: 'status', status: 500 },
    { kind: 'status', status: 503 },
    { kind: 'jsonError' },
    { kind: 'error', message: SYNTHETIC_RAW_ERROR }
  ];
  for (const scenario of scenarios) {
    const fetchImpl = makeVertexOnlyFetch({ images: [], responseOverrides: [scenario] });
    const client = createVertexClient({
      config: BASE_CONFIG,
      fetchImpl,
      getAccessToken: async () => 'token'
    });
    await assert.rejects(
      () => client.generate({ prompt: SYNTHETIC_PROMPT, model: 'gemini-3.1-flash-image', variants: 1 }),
      (error) => {
        assert.equal(error.code, 'VERTEX_ERROR');
        assert.equal(error.message.includes(SYNTHETIC_RAW_ERROR), false);
        assert.equal(error.message.includes(SYNTHETIC_TOKEN), false);
        return true;
      }
    );
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.vertexCallCount(), 1);
  }
});

test('createVertexClient preserves successful images and returns partial true when some variants fail', async () => {
  const responseOverrides = [
    { kind: 'body', body: makeVertexResponse([makeImagePart(IMAGE_ONE)]) },
    { kind: 'status', status: 429 },
    { kind: 'body', body: makeVertexResponse([makeImagePart(IMAGE_TWO)]) },
    { kind: 'jsonError' }
  ];
  const fetchImpl = makeVertexOnlyFetch({ images: [], responseOverrides });
  const client = createVertexClient({
    config: BASE_CONFIG,
    fetchImpl,
    getAccessToken: async () => 'token'
  });
  const result = await client.generate({ prompt: 'p', model: 'gemini-3.1-flash-image', variants: 4 });
  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(result.images, [FINAL_IMAGE_ONE, FINAL_IMAGE_TWO]);
  assert.equal(result.costUsd, 2 * GLOBAL_ONE_K_USD);
  assert.equal(result.blocked, false);
  assert.equal(result.blockReason, null);
  assert.equal(result.partial, true);
});

test('createVertexClient mixed safety and empty success with zero images throws VERTEX_ERROR in both orders', async () => {
  const emptyBody = makeEmptyBody();
  const safetyBody = makeSafetyBody();
  const orders = [
    [emptyBody, safetyBody],
    [safetyBody, emptyBody]
  ];
  for (const [first, second] of orders) {
    const responseOverrides = [
      { kind: 'body', body: first },
      { kind: 'body', body: second }
    ];
    const fetchImpl = makeVertexOnlyFetch({ images: [], responseOverrides });
    const client = createVertexClient({
      config: BASE_CONFIG,
      fetchImpl,
      getAccessToken: async () => 'token'
    });
    await assert.rejects(
      () => client.generate({ prompt: 'p', model: 'gemini-3.1-flash-image', variants: 2 }),
      (error) => error.code === 'VERTEX_ERROR'
    );
    assert.equal(fetchImpl.calls.length, 2);
  }
});

test('createVertexClient all-safety variants return blocked with zero cost', async () => {
  const responseOverrides = [
    { kind: 'body', body: makeSafetyBody() },
    { kind: 'body', body: makeSafetyBody() }
  ];
  const fetchImpl = makeVertexOnlyFetch({ images: [], responseOverrides });
  const client = createVertexClient({
    config: BASE_CONFIG,
    fetchImpl,
    getAccessToken: async () => 'token'
  });
  const result = await client.generate({ prompt: 'p', model: 'gemini-3.1-flash-image', variants: 2 });
  assert.deepEqual(result.images, []);
  assert.equal(result.costUsd, 0);
  assert.equal(result.blocked, true);
  assert.equal(result.blockReason, 'SAFETY');
  assert.equal(result.partial, false);
});

test('createVertexClient exclusively empty successful outputs throw NO_IMAGES', async () => {
  const emptyBody = makeEmptyBody();
  const responseOverrides = [
    { kind: 'body', body: emptyBody },
    { kind: 'body', body: emptyBody }
  ];
  const fetchImpl = makeVertexOnlyFetch({ images: [], responseOverrides });
  const client = createVertexClient({
    config: BASE_CONFIG,
    fetchImpl,
    getAccessToken: async () => 'token'
  });
  await assert.rejects(
    () => client.generate({ prompt: 'p', model: 'gemini-3.1-flash-image', variants: 2 }),
    (error) => error.code === 'NO_IMAGES'
  );
});

test('createVertexClient mixed safety and successful image returns image and partial true', async () => {
  const responseOverrides = [
    { kind: 'body', body: makeVertexResponse([makeImagePart(IMAGE_ONE)]) },
    { kind: 'body', body: makeSafetyBody() }
  ];
  const fetchImpl = makeVertexOnlyFetch({ images: [], responseOverrides });
  const client = createVertexClient({
    config: BASE_CONFIG,
    fetchImpl,
    getAccessToken: async () => 'token'
  });
  const result = await client.generate({ prompt: 'p', model: 'gemini-3.1-flash-image', variants: 2 });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].bytesBase64, IMAGE_ONE);
  assert.equal(result.costUsd, GLOBAL_ONE_K_USD);
  assert.equal(result.blocked, false);
  assert.equal(result.blockReason, null);
  assert.equal(result.partial, true);
});

// HTTP boundary via actual createProxyServer

test('createProxyServer returns an unlistened node:http Server', () => {
  const server = createProxyServer({ config: BASE_CONFIG, generate: async () => ({}) });
  assert.equal(server.listening, false);
});

test('actual loopback proxy with default vertex client returns HTTP200 no-store JSON for 4 variants', async () => {
  const vertexImages = [IMAGE_ONE, IMAGE_TWO, IMAGE_THREE, IMAGE_FOUR];
  const fetchImpl = makeMetadataAndVertexFetch({ vertexImages });
  const server = createProxyServer({ config: BASE_CONFIG, fetchImpl });
  const port = await listen(server);
  try {
    const response = await postJson(port, '/generate', {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SYNTHETIC_SECRET}`
      },
      body: JSON.stringify({
        prompt: SYNTHETIC_PROMPT,
        model: 'gemini-3.1-flash-image',
        variants: 4
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.images, FINAL_IMAGES);
    assert.equal(body.costUsd, 0.2688);
    assert.equal(body.blocked, false);
    assert.equal(body.blockReason, null);
    assert.equal(body.partial, false);
    assert.equal(fetchImpl.metadataCallCount(), 1);
    assert.equal(fetchImpl.vertexCallCount(), 4);
    assert.equal(fetchImpl.calls.length, 5);

    for (const call of fetchImpl.calls.filter(call => call.url.includes(':generateContent'))) {
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.headers.Authorization, `Bearer ${SYNTHETIC_TOKEN}`);
      assert.equal(call.options.headers['Content-Type'], 'application/json');
    }
  } finally {
    await close(server);
  }
});

test('actual loopback proxy returns exactly one variant and metadata call', async () => {
  const vertexImages = [IMAGE_ONE];
  const fetchImpl = makeMetadataAndVertexFetch({ vertexImages });
  const server = createProxyServer({ config: BASE_CONFIG, fetchImpl });
  const port = await listen(server);
  try {
    const response = await postJson(port, '/generate', {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SYNTHETIC_SECRET}`
      },
      body: JSON.stringify({
        prompt: SYNTHETIC_PROMPT,
        model: 'gemini-3.1-flash-image',
        variants: 1
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.images.length, 1);
    assert.deepEqual(body.images[0], FINAL_IMAGE_ONE);
    assert.equal(body.costUsd, GLOBAL_ONE_K_USD);
    assert.equal(fetchImpl.metadataCallCount(), 1);
    assert.equal(fetchImpl.vertexCallCount(), 1);
  } finally {
    await close(server);
  }
});

test('createProxyServer returns 404/405 before auth', async () => {
  let generateCalls = 0;
  const generate = async () => { generateCalls += 1; };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const notFound = await fetch(`http://127.0.0.1:${port}/other`);
    assert.equal(notFound.status, 404);
    const methodNotAllowed = await fetch(`http://127.0.0.1:${port}/generate`, { method: 'GET' });
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(generateCalls, 0);
  } finally {
    await close(server);
  }
});

test('createProxyServer enforces auth before parsing body', async () => {
  let generateCalls = 0;
  const generate = async () => { generateCalls += 1; };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json'
    });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json'
      },
      body: 'not-json'
    });
    assert.equal(wrong.status, 401);
    assert.equal(generateCalls, 0);
  } finally {
    await close(server);
  }
});

test('createProxyServer returns 415 for non-json content type', async () => {
  const generate = async () => { throw new Error('should not call'); };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SYNTHETIC_SECRET}`,
        'content-type': 'text/plain'
      },
      body: 'hello'
    });
    assert.equal(response.status, 415);
  } finally {
    await close(server);
  }
});

test('createProxyServer returns 400 for malformed JSON body', async () => {
  const generate = async () => { throw new Error('should not call'); };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SYNTHETIC_SECRET}`,
        'content-type': 'application/json'
      },
      body: '{bad json'
    });
    assert.equal(response.status, 400);
  } finally {
    await close(server);
  }
});

test('createProxyServer returns 400 for validated invalid body', async () => {
  const generate = async () => { throw new Error('should not call'); };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SYNTHETIC_SECRET}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ prompt: '', model: 'gemini-3.1-flash-image', variants: 1 })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'BAD_REQUEST');
  } finally {
    await close(server);
  }
});

test('createProxyServer returns 413 for body over 65536 bytes', async () => {
  const generate = async () => { throw new Error('should not call'); };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SYNTHETIC_SECRET}`,
        'content-type': 'application/json'
      },
      body: 'x'.repeat(70000)
    });
    assert.equal(response.status, 413);
  } finally {
    await close(server);
  }
});

test('createProxyServer returns sanitized 502 and no-store on provider error', async () => {
  const generate = async () => {
    const error = new Error(SYNTHETIC_RAW_ERROR);
    error.code = 'VERTEX_ERROR';
    throw error;
  };
  const server = createProxyServer({ config: BASE_CONFIG, generate });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/generate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SYNTHETIC_SECRET}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        prompt: SYNTHETIC_PROMPT,
        model: 'gemini-3.1-flash-image',
        variants: 1
      })
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.error.code, 'VERTEX_ERROR');
    assert.equal(body.error.message, 'Image generation failed');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(SYNTHETIC_RAW_ERROR), false);
    assert.equal(serialized.includes(SYNTHETIC_SECRET), false);
    assert.equal(serialized.includes(SYNTHETIC_PROMPT), false);
    assert.equal(serialized.includes(SYNTHETIC_TOKEN), false);
  } finally {
    await close(server);
  }
});

// Safe startup behavior

test('missing VERTEX_LOCATION subprocess exits nonzero without hanging or leaking secret', async () => {
  const serverPath = fileURLToPath(new URL('../kaplan-image-proxy/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      VERTEX_LOCATION: '',
      PROXY_SHARED_SECRET: 'unused-secret-sentinel'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('subprocess did not exit'));
    }, 3000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  assert.notEqual(exitCode, 0);
  assert.equal(stderr.includes('unused-secret-sentinel'), false);
  assert.equal(stdout.includes('unused-secret-sentinel'), false);
  assert.ok(stderr.includes('VERTEX_LOCATION'));
});
