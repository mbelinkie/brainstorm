// Fixture-only tests for ENGINES.openrouter (issue #44).
// resolveAuth/buildRequests/parseResponses are called directly with inline
// objects. No HTTP request is made, OpenRouter is never contacted, and the
// only credential is a synthetic string.
//
// The `results` fixtures use the exact shape cloudflare-worker.js hands to
// parseResponses (the /battle/test-image route, addendum section 2.3):
//
//   fulfilled                  -> { ok: true, body: <parsed JSON> }
//   rejected (non-2xx)         -> { ok: false, status: <HTTP status>, error }
//                                 where runBattleDescriptor threw
//                                 Error("<url> returned <status>") with
//                                 error.status set
//   rejected (no response)     -> { ok: false, status: 0, error }
//                                 (fetch threw, or a 2xx body was not JSON;
//                                 entry.reason?.status ?? 0)
//
// The current Worker discards the body of a non-2xx response. The adapter
// reads OpenRouter's { error: { code, message } } body from error.body when
// a Worker supplies it there (see the comment on OPENROUTER_REFUSAL_CODES in
// image-engine.js); until then a refusal is refunded as an ordinary failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES } from '../image-engine.js';

const openrouter = ENGINES.openrouter;

const ENDPOINT = 'https://openrouter.ai/api/v1/images';
const SYNTHETIC_KEY = 'sk-or-v1-synthetic-test-key-0000';
const FIXTURE_AUTH = {
  url: ENDPOINT,
  headers: { Authorization: `Bearer ${SYNTHETIC_KEY}` }
};
const MODEL = 'google/gemini-3.1-flash-image-preview';
const PROMPT = 'A llama piloting a hot air balloon over a quiz show set';

// Base64 prefixes of real file signatures, padded with filler.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD';
const WEBP_B64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAw';
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP';

function success(images, cost) {
  return {
    ok: true,
    body: {
      created: 1759622400,
      data: images,
      usage: { cost }
    }
  };
}

// The shape runBattleDescriptor produces today for a non-2xx response.
function httpFailure(status, errorBody) {
  const error = new Error(`${ENDPOINT} returned ${status}`);
  error.status = status;
  if (errorBody !== undefined) error.body = errorBody;
  return { ok: false, status, error };
}

// The shape for a request that never got a response.
function noResponse() {
  return { ok: false, status: 0, error: new TypeError('Network connection lost.') };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// --- A9: resolveAuth ---------------------------------------------------

test('A9 resolveAuth returns the images endpoint and a trimmed bearer header', async () => {
  const auth = await openrouter.resolveAuth({ OPENROUTER_API_KEY: `  ${SYNTHETIC_KEY}\n` });
  assert.deepEqual(auth, {
    url: ENDPOINT,
    headers: { Authorization: `Bearer ${SYNTHETIC_KEY}` }
  });
});

test('A9 resolveAuth rejects a missing, blank or non-string key, naming the variable and never echoing the value', async () => {
  const cases = [
    {},
    undefined,
    { OPENROUTER_API_KEY: '' },
    { OPENROUTER_API_KEY: '   \t ' },
    { OPENROUTER_API_KEY: null },
    { OPENROUTER_API_KEY: 987654321 },
    { OPENROUTER_API_KEY: { secret: 'sk-or-v1-object-secret' } },
    { OPENROUTER_API_KEY: ['sk-or-v1-array-secret'] }
  ];
  for (const env of cases) {
    await assert.rejects(
      () => openrouter.resolveAuth(env),
      (error) => {
        assert.match(error.message, /OPENROUTER_API_KEY/);
        assert.doesNotMatch(error.message, /987654321|object-secret|array-secret/);
        return true;
      }
    );
  }
});

// --- A1: buildRequests -------------------------------------------------

test('A1 three variants give three descriptors with bearer, JSON content type and body exactly { model, prompt, n: 1 }', () => {
  const descriptors = openrouter.buildRequests({
    model: MODEL,
    prompt: PROMPT,
    variants: 3,
    seeds: [11, 22, 33],
    auth: FIXTURE_AUTH
  });
  assert.equal(descriptors.length, 3);
  for (const descriptor of descriptors) {
    assert.deepEqual(descriptor, {
      kind: 'http',
      url: ENDPOINT,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${SYNTHETIC_KEY}`
      },
      body: { model: MODEL, prompt: PROMPT, n: 1 }
    });
  }
  // Fresh objects per variant: mutating one cannot reach the others.
  descriptors[0].body.prompt = 'mutated';
  descriptors[0].headers.extra = 'x';
  assert.equal(descriptors[1].body.prompt, PROMPT);
  assert.equal(descriptors[2].headers.extra, undefined);
});

test('A1 resolution and outputFormat go into every body as resolution and output_format, and nothing else does', () => {
  const descriptors = openrouter.buildRequests({
    model: MODEL,
    prompt: PROMPT,
    variants: 2,
    resolution: '1K',
    outputFormat: 'png',
    seeds: [1, 2],
    seed: 5,
    aspectRatio: '1:1',
    outputCompression: 80,
    provider: 'openrouter',
    attemptsRemaining: 2,
    auth: FIXTURE_AUTH
  });
  assert.equal(descriptors.length, 2);
  for (const descriptor of descriptors) {
    assert.deepEqual(descriptor.body, {
      model: MODEL,
      prompt: PROMPT,
      n: 1,
      resolution: '1K',
      output_format: 'png'
    });
  }

  const onlyResolution = openrouter.buildRequests({
    model: MODEL, prompt: PROMPT, variants: 1, resolution: '2K', auth: FIXTURE_AUTH
  });
  assert.deepEqual(onlyResolution[0].body, { model: MODEL, prompt: PROMPT, n: 1, resolution: '2K' });

  const onlyFormat = openrouter.buildRequests({
    model: MODEL, prompt: PROMPT, variants: 1, outputFormat: 'webp', auth: FIXTURE_AUTH
  });
  assert.deepEqual(onlyFormat[0].body, { model: MODEL, prompt: PROMPT, n: 1, output_format: 'webp' });

  const unset = openrouter.buildRequests({
    model: MODEL, prompt: PROMPT, variants: 1, resolution: null, outputFormat: undefined, auth: FIXTURE_AUTH
  });
  assert.deepEqual(unset[0].body, { model: MODEL, prompt: PROMPT, n: 1 });
});

test('buildRequests requires the resolved auth object', () => {
  for (const auth of [undefined, null, 'Bearer x', { url: ENDPOINT }, { headers: {} }]) {
    assert.throws(
      () => openrouter.buildRequests({ model: MODEL, prompt: PROMPT, variants: 1, auth }),
      /openrouter\.buildRequests requires the resolved auth object from resolveAuth/
    );
  }
});

// --- A10: limits -------------------------------------------------------

test('A10 variants outside the whole numbers 1 to 4 throw; 1 to 4 are accepted', () => {
  for (const variants of [0, 5, -1, 1.5, '2', null, undefined, NaN, Infinity]) {
    assert.throws(
      () => openrouter.buildRequests({ model: MODEL, prompt: PROMPT, variants, auth: FIXTURE_AUTH }),
      /openrouter\.buildRequests requires variants to be an integer between 1 and 4/
    );
  }
  for (const variants of [1, 2, 3, 4]) {
    const descriptors = openrouter.buildRequests({ model: MODEL, prompt: PROMPT, variants, auth: FIXTURE_AUTH });
    assert.equal(descriptors.length, variants);
  }
});

test('A10 expectedVariants outside the whole numbers 1 to 4 throw; 1 to 4 are accepted', () => {
  const results = [success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.01)];
  for (const expectedVariants of [0, 5, -1, 2.5, '1', null, undefined, NaN, Infinity]) {
    assert.throws(
      () => openrouter.parseResponses({ results, expectedVariants }),
      /openrouter\.parseResponses requires expectedVariants to be an integer between 1 and 4/
    );
  }
  for (const expectedVariants of [1, 2, 3, 4]) {
    const parsed = openrouter.parseResponses({ results, expectedVariants });
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.partial, expectedVariants > 1);
  }
});

// --- A2: all succeed ---------------------------------------------------

test('A2 two successes with one image each and cost 0.045 give two images in order, costUsd 0.09, not partial, not blocked', () => {
  const parsed = openrouter.parseResponses({
    results: [
      success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.045),
      success([{ b64_json: JPEG_B64, media_type: 'image/jpeg' }], 0.045)
    ],
    expectedVariants: 2
  });
  assert.deepEqual(parsed, {
    images: [
      { mimeType: 'image/png', bytesBase64: PNG_B64 },
      { mimeType: 'image/jpeg', bytesBase64: JPEG_B64 }
    ],
    costUsd: 0.09,
    blocked: false,
    blockReason: null,
    partial: false
  });
});

test('costs are summed exactly with no rounding, and more images than requested are all kept', () => {
  const parsed = openrouter.parseResponses({
    results: [
      success([
        { b64_json: PNG_B64, media_type: 'image/png' },
        { b64_json: WEBP_B64, media_type: 'image/webp' }
      ], 0.0391234),
      success([{ b64_json: JPEG_B64, media_type: 'image/jpeg' }], 0)
    ],
    expectedVariants: 2
  });
  assert.equal(parsed.costUsd, 0.0391234 + 0);
  assert.equal(parsed.images.length, 3);
  assert.equal(parsed.partial, false);
});

// --- A3: mixed success and OpenRouter error ----------------------------

test('A3 one success and one OpenRouter 502 error give one image, only the success cost, and partial true', () => {
  // As the current Worker delivers it: status only, no error body.
  const parsed = openrouter.parseResponses({
    results: [
      success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.045),
      httpFailure(502)
    ],
    expectedVariants: 2
  });
  assert.deepEqual(parsed, {
    images: [{ mimeType: 'image/png', bytesBase64: PNG_B64 }],
    costUsd: 0.045,
    blocked: false,
    blockReason: null,
    partial: true
  });

  // The same with the OpenRouter error body attached.
  const withBody = openrouter.parseResponses({
    results: [
      httpFailure(502, { error: { code: 502, message: 'Provider returned error' } }),
      success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.045)
    ],
    expectedVariants: 2
  });
  assert.equal(withBody.images.length, 1);
  assert.equal(withBody.costUsd, 0.045);
  assert.equal(withBody.partial, true);
  assert.equal(withBody.blocked, false);
});

// --- A4: all fail with OpenRouter errors -------------------------------

test('A4 all requests failing with OpenRouter error responses give no images, costUsd 0 and blocked false', () => {
  const parsed = openrouter.parseResponses({
    results: [
      httpFailure(502),
      httpFailure(429, { error: { code: 429, message: 'Rate limit exceeded' } }),
      httpFailure(400, { error: { code: 400, message: 'n must be 1 for this model' } })
    ],
    expectedVariants: 3
  });
  assert.deepEqual(parsed, {
    images: [],
    costUsd: 0,
    blocked: false,
    blockReason: null,
    partial: false
  });
});

// --- A5: no response at all --------------------------------------------

test('A5 any request with no response throws Unaccounted OpenRouter outcome, even when others succeeded', () => {
  const scenarios = [
    [noResponse()],
    [success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.045), noResponse()],
    [noResponse(), success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.045)],
    [httpFailure(502), noResponse()],
    // A missing, 2xx or non-numeric status on a failed result is not proof
    // that OpenRouter answered with an error, so its cost is unknown too.
    [{ ok: false, error: new Error('timeout') }],
    [{ ok: false, status: 200, error: new Error('impossible') }],
    [{ ok: false, status: '502', error: new Error('string status') }],
    [null],
    []
  ];
  for (const results of scenarios) {
    assert.throws(
      () => openrouter.parseResponses({ results, expectedVariants: 2 }),
      /Unaccounted OpenRouter outcome/
    );
  }
  assert.throws(
    () => openrouter.parseResponses({ results: undefined, expectedVariants: 2 }),
    /Unaccounted OpenRouter outcome/
  );
});

// --- A6: bad usage.cost ------------------------------------------------

test('A6 a success with usage.cost missing, null, a string, negative, NaN or infinite throws Unaccounted OpenRouter outcome', () => {
  const image = [{ b64_json: PNG_B64, media_type: 'image/png' }];
  const bodies = [
    { data: image },
    { data: image, usage: {} },
    { data: image, usage: null },
    { data: image, usage: { cost: null } },
    { data: image, usage: { cost: '0.045' } },
    { data: image, usage: { cost: -0.01 } },
    { data: image, usage: { cost: NaN } },
    { data: image, usage: { cost: Infinity } },
    { data: image, usage: { cost: -Infinity } },
    null,
    'not an object'
  ];
  for (const body of bodies) {
    assert.throws(
      () => openrouter.parseResponses({
        results: [success(image, 0.045), { ok: true, body }],
        expectedVariants: 2
      }),
      /Unaccounted OpenRouter outcome/
    );
  }
});

test('a cost total that overflows to infinity throws Unaccounted OpenRouter outcome', () => {
  assert.throws(
    () => openrouter.parseResponses({
      results: [success([], Number.MAX_VALUE), success([], Number.MAX_VALUE)],
      expectedVariants: 2
    }),
    /Unaccounted OpenRouter outcome/
  );
});

// --- A7: safety refusals -----------------------------------------------

test('A7 no images and a content_policy_violation or refusal error give blocked true with that message', () => {
  for (const code of ['content_policy_violation', 'refusal']) {
    const parsed = openrouter.parseResponses({
      results: [
        httpFailure(502),
        httpFailure(400, { error: { code, message: `Declined (${code}).` } })
      ],
      expectedVariants: 2
    });
    assert.deepEqual(parsed, {
      images: [],
      costUsd: 0,
      blocked: true,
      blockReason: `Declined (${code}).`,
      partial: false
    });
  }
});

test('A7 the first refusal message wins, and a refusal is not a block when any image came back', () => {
  const first = openrouter.parseResponses({
    results: [
      httpFailure(400, { error: { code: 'refusal', message: 'First reason.' } }),
      httpFailure(400, { error: { code: 'content_policy_violation', message: 'Second reason.' } })
    ],
    expectedVariants: 2
  });
  assert.equal(first.blocked, true);
  assert.equal(first.blockReason, 'First reason.');

  const withImage = openrouter.parseResponses({
    results: [
      success([{ b64_json: PNG_B64, media_type: 'image/png' }], 0.045),
      httpFailure(400, { error: { code: 'content_policy_violation', message: 'Blocked.' } })
    ],
    expectedVariants: 2
  });
  assert.equal(withImage.blocked, false);
  assert.equal(withImage.blockReason, null);
  assert.equal(withImage.partial, true);
});

test('A7 other error codes, and errors without a body, are not blocks', () => {
  const parsed = openrouter.parseResponses({
    results: [
      httpFailure(400, { error: { code: 400, message: 'Bad request' } }),
      httpFailure(403, { error: { code: 'moderation', message: 'Flagged' } }),
      httpFailure(400)
    ],
    expectedVariants: 3
  });
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
});

// --- A8: media type ----------------------------------------------------

test('A8 a missing media_type is inferred for PNG, JPEG and WebP from the base64 prefix', () => {
  const parsed = openrouter.parseResponses({
    results: [
      success([{ b64_json: PNG_B64 }], 0.01),
      success([{ b64_json: JPEG_B64, media_type: null }], 0.02),
      success([{ b64_json: WEBP_B64, media_type: '' }], 0.03)
    ],
    expectedVariants: 3
  });
  assert.deepEqual(parsed.images, [
    { mimeType: 'image/png', bytesBase64: PNG_B64 },
    { mimeType: 'image/jpeg', bytesBase64: JPEG_B64 },
    { mimeType: 'image/webp', bytesBase64: WEBP_B64 }
  ]);
  assert.equal(parsed.costUsd, 0.01 + 0.02 + 0.03);
  assert.equal(parsed.partial, false);
});

test('A8 an unknown or non-image type is dropped and its cost still counts', () => {
  const parsed = openrouter.parseResponses({
    results: [
      success([{ b64_json: GIF_B64 }], 0.045),
      success([{ b64_json: PNG_B64, media_type: 'application/json' }], 0.045),
      success([
        { b64_json: '   ', media_type: 'image/png' },
        { media_type: 'image/png' },
        { url: 'https://example.invalid/x.png' },
        null,
        'iVBORw0KGgo'
      ], 0.045)
    ],
    expectedVariants: 3
  });
  assert.deepEqual(parsed.images, []);
  assert.equal(parsed.costUsd, 0.045 + 0.045 + 0.045);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.partial, false);

  const missingData = openrouter.parseResponses({
    results: [{ ok: true, body: { usage: { cost: 0.02 } } }],
    expectedVariants: 1
  });
  assert.deepEqual(missingData.images, []);
  assert.equal(missingData.costUsd, 0.02);
});

test('A8 an explicit image/* media_type is kept as given', () => {
  const parsed = openrouter.parseResponses({
    results: [success([{ b64_json: PNG_B64, media_type: 'image/jpeg' }], 0.01)],
    expectedVariants: 1
  });
  assert.deepEqual(parsed.images, [{ mimeType: 'image/jpeg', bytesBase64: PNG_B64 }]);
});

// --- A11: purity -------------------------------------------------------

test('A11 no network call, inputs untouched, and the same output for the same input', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('openrouter adapter must not fetch');
  };
  try {
    const env = deepFreeze({ OPENROUTER_API_KEY: SYNTHETIC_KEY });
    const auth1 = await openrouter.resolveAuth(env);
    const auth2 = await openrouter.resolveAuth(env);
    assert.deepEqual(auth1, auth2);

    const config = deepFreeze({
      model: MODEL,
      prompt: PROMPT,
      variants: 3,
      resolution: '1K',
      outputFormat: 'png',
      seeds: [1, 2, 3],
      auth: FIXTURE_AUTH
    });
    const configSnapshot = structuredClone(config);
    const built1 = openrouter.buildRequests(config);
    const built2 = openrouter.buildRequests(config);
    assert.deepEqual(built1, built2);
    assert.deepEqual(config, configSnapshot);

    const input = deepFreeze({
      results: [
        success([{ b64_json: PNG_B64 }], 0.045),
        httpFailure(502, { error: { code: 502, message: 'Provider returned error' } }),
        success([{ b64_json: JPEG_B64, media_type: 'image/jpeg' }], 0.03)
      ],
      expectedVariants: 3
    });
    const parsed1 = openrouter.parseResponses(input);
    const parsed2 = openrouter.parseResponses(input);
    assert.deepEqual(parsed1, parsed2);
    assert.equal(parsed1.images.length, 2);
    assert.equal(parsed1.partial, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});
