// Fixture-only regression tests for ENGINES.kaplan_proxy.
// These tests call resolveAuth/buildRequests/parseResponses directly with
// inline objects; no HTTP request is made, no live Cloud Run proxy is
// contacted, and no live billing or credentials are involved.
//
// The adapter under test is imported from ../image-engine.js, so these
// exercises run against the real pure module, not a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES } from '../image-engine.js';

const kaplan = ENGINES.kaplan_proxy;

// buildRequests trusts only config.auth. This fixture is deliberately shaped
// like the object resolveAuth() returns, but it stays an inline string/object
// so these tests never touch env parsing, fetch, or live services.
const FIXTURE_AUTH = {
  url: 'https://proxy.example/generate',
  headers: { Authorization: 'Bearer server-secret' }
};
const VALID_MODEL = 'gemini-3.1-flash-image';

// --- resolveAuth -------------------------------------------------------

test('kaplan_proxy.resolveAuth computes /generate endpoint and Bearer header without touching network', async () => {
  const auth = await kaplan.resolveAuth({
    KAPLAN_PROXY_URL: 'https://proxy.example',
    KAPLAN_PROXY_SECRET: 'server-secret'
  });
  assert.equal(auth.url, 'https://proxy.example/generate');
  assert.deepEqual(auth.headers, { Authorization: 'Bearer server-secret' });
});

test('kaplan_proxy.resolveAuth rejects missing/invalid HTTPS base URL and missing/blank secret without echoing values', async () => {
  await assert.rejects(
    () => kaplan.resolveAuth({}),
    /Kaplan proxy URL is not configured/
  );
  await assert.rejects(
    () => kaplan.resolveAuth({ KAPLAN_PROXY_URL: '   ', KAPLAN_PROXY_SECRET: 'x' }),
    /Kaplan proxy URL is not configured/
  );
  await assert.rejects(
    () => kaplan.resolveAuth({ KAPLAN_PROXY_URL: 'http://proxy.example', KAPLAN_PROXY_SECRET: 'x' }),
    /Kaplan proxy URL must be a valid HTTPS URL/
  );
  await assert.rejects(
    () => kaplan.resolveAuth({ KAPLAN_PROXY_URL: 'not-a-url', KAPLAN_PROXY_SECRET: 'x' }),
    /Kaplan proxy URL must be a valid HTTPS URL/
  );
  await assert.rejects(
    () => kaplan.resolveAuth({ KAPLAN_PROXY_URL: 'https://proxy.example' }),
    /Kaplan proxy secret is not configured/
  );
  await assert.rejects(
    () => kaplan.resolveAuth({ KAPLAN_PROXY_URL: 'https://proxy.example', KAPLAN_PROXY_SECRET: '   ' }),
    /Kaplan proxy secret is not configured/
  );
});

// --- buildRequests -----------------------------------------------------

test('kaplan_proxy.buildRequests returns one inert HTTP descriptor for 4 variants from auth only', () => {
  const descriptors = kaplan.buildRequests({
    prompt: 'a cat in a hat',
    model: VALID_MODEL,
    variants: 4,
    auth: FIXTURE_AUTH,
    // Client-supplied hints must not influence the descriptor. Issue #21 owns
    // caller security/provenance; this pure module consumes only config.auth.
    url: 'https://client-controlled.example/generate',
    headers: { Authorization: 'Bearer client-secret', 'x-client': 'ignored' },
    secret: 'client-secret'
  });

  assert.equal(descriptors.length, 1);
  assert.deepEqual(descriptors[0], {
    kind: 'http',
    url: 'https://proxy.example/generate',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Bearer server-secret'
    },
    body: {
      prompt: 'a cat in a hat',
      model: VALID_MODEL,
      variants: 4
    }
  });
});

test('kaplan_proxy.buildRequests forwards prompt/model exactly and does not clip prompt', () => {
  const prompt = 'a'.repeat(5000);
  const [descriptor] = kaplan.buildRequests({
    prompt,
    model: VALID_MODEL,
    variants: 2,
    auth: FIXTURE_AUTH
  });

  assert.equal(descriptor.body.prompt, prompt);
  assert.equal(descriptor.body.model, VALID_MODEL);
  assert.deepEqual(Object.keys(descriptor.body).sort(), ['model', 'prompt', 'variants']);
});

test('kaplan_proxy.buildRequests requires the resolved auth object from resolveAuth', () => {
  assert.throws(
    () => kaplan.buildRequests({ prompt: 'p', model: VALID_MODEL, variants: 1 }),
    /requires the resolved auth object from resolveAuth/
  );
  assert.throws(
    () => kaplan.buildRequests({ prompt: 'p', model: VALID_MODEL, variants: 1, auth: null }),
    /requires the resolved auth object from resolveAuth/
  );
  assert.throws(
    () => kaplan.buildRequests({ prompt: 'p', model: VALID_MODEL, variants: 1, auth: {} }),
    /requires the resolved auth object from resolveAuth/
  );
  assert.throws(
    () => kaplan.buildRequests({ prompt: 'p', model: VALID_MODEL, variants: 1, auth: { url: 'https://proxy.example/generate' } }),
    /requires the resolved auth object from resolveAuth/
  );
});

test('kaplan_proxy.buildRequests rejects variants outside integer 1..4', () => {
  const invalidVariants = [undefined, null, 0, 5, 1.5, '2', false, NaN];
  for (const variants of invalidVariants) {
    assert.throws(
      () => kaplan.buildRequests({ prompt: 'p', model: VALID_MODEL, variants, auth: FIXTURE_AUTH }),
      /variants to be an integer between 1 and 4/,
      `expected variants=${String(variants)} to be rejected`
    );
  }
});

// --- parseResponses ------------------------------------------------------

test('kaplan_proxy.parseResponses returns valid images in source order and sums numeric cost', () => {
  const parsed = kaplan.parseResponses({
    results: [
      {
        ok: true,
        body: {
          images: [{ mimeType: 'image/jpeg', bytesBase64: 'JPEG_BYTES' }],
          costUsd: 1
        }
      },
      {
        ok: true,
        body: {
          images: [
            { mimeType: 'image/png', bytesBase64: 'PNG_BYTES' },
            { mimeType: 'image/webp', bytesBase64: 'WEBP_BYTES' }
          ],
          costUsd: 2
        }
      }
    ],
    expectedVariants: 3
  });

  assert.deepEqual(parsed.images, [
    { mimeType: 'image/jpeg', bytesBase64: 'JPEG_BYTES' },
    { mimeType: 'image/png', bytesBase64: 'PNG_BYTES' },
    { mimeType: 'image/webp', bytesBase64: 'WEBP_BYTES' }
  ]);
  assert.equal(parsed.costUsd, 3); // 1 + 2 exactly; no provider/price table is consulted
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
  assert.equal(parsed.partial, false); // 3 images, expectedVariants 3
});

test('kaplan_proxy.parseResponses reports partial when valid images are fewer than expectedVariants', () => {
  const parsed = kaplan.parseResponses({
    results: [
      {
        ok: true,
        body: {
          images: [
            { mimeType: 'image/jpeg', bytesBase64: 'IMG_1' },
            { mimeType: 'image/jpeg', bytesBase64: 'IMG_2' }
          ],
          costUsd: 0.25
        }
      }
    ],
    expectedVariants: 4
  });

  assert.equal(parsed.images.length, 2);
  assert.equal(parsed.costUsd, 0.25);
  assert.equal(parsed.partial, true);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
});

test('kaplan_proxy.parseResponses reports safety block only when zero valid images accompany an explicit block signal', () => {
  const parsed = kaplan.parseResponses({
    results: [
      {
        ok: true,
        body: {
          images: [],
          costUsd: 0.05,
          blocked: true,
          blockReason: 'content policy'
        }
      }
    ],
    expectedVariants: 2
  });

  assert.deepEqual(parsed.images, []);
  assert.equal(parsed.costUsd, 0.05);
  assert.equal(parsed.blocked, true);
  assert.equal(parsed.blockReason, 'content policy');
  assert.equal(parsed.partial, false);
});

test('kaplan_proxy.parseResponses treats a nonblank blockReason alone as an explicit block', () => {
  const parsed = kaplan.parseResponses({
    results: [
      {
        ok: true,
        body: {
          images: [],
          costUsd: 0.03,
          blocked: false,
          blockReason: 'safety'
        }
      }
    ],
    expectedVariants: 1
  });

  assert.equal(parsed.blocked, true);
  assert.equal(parsed.blockReason, 'safety');
});

test('kaplan_proxy.parseResponses preserves positive cost for a valid paid empty result without safety block', () => {
  const parsed = kaplan.parseResponses({
    results: [{ ok: true, body: { images: [], costUsd: 0.02 } }],
    expectedVariants: 3
  });

  assert.deepEqual(parsed.images, []);
  assert.equal(parsed.costUsd, 0.02);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
  assert.equal(parsed.partial, false);
});

test('kaplan_proxy.parseResponses preserves zero cost for a valid empty result', () => {
  const parsed = kaplan.parseResponses({
    results: [{ ok: true, body: { images: [], costUsd: 0 } }],
    expectedVariants: 1
  });

  assert.equal(parsed.costUsd, 0);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.blockReason, null);
});

test('kaplan_proxy.parseResponses drops malformed image entries but keeps every valid one and the reported cost', () => {
  const parsed = kaplan.parseResponses({
    results: [{
      ok: true,
      body: {
        images: [
          { mimeType: 'image/jpeg', bytesBase64: 'GOOD_JPEG' },
          { mimeType: 'application/json', bytesBase64: 'NOT_IMAGE' },
          'raw-string',
          null,
          { bytesBase64: 'MISSING_MIME' },
          { mimeType: 'image/png', bytesBase64: '' },
          { mimeType: ' image/jpeg', bytesBase64: 'SPACE_MIME' }, // strict startsWith('image/')
          { mimeType: 'image/webp', bytesBase64: 'GOOD_WEBP' },
          { mimeType: 'image/jpeg', bytesBase64: 42 }
        ],
        costUsd: 0.2
      }
    }],
    expectedVariants: 4
  });

  assert.deepEqual(parsed.images, [
    { mimeType: 'image/jpeg', bytesBase64: 'GOOD_JPEG' },
    { mimeType: 'image/webp', bytesBase64: 'GOOD_WEBP' }
  ]);
  assert.equal(parsed.costUsd, 0.2);
  assert.equal(parsed.partial, true); // 2 valid images < 4 expected
});

test('kaplan_proxy.parseResponses throws unaccounted-proxy-outcome for empty results', () => {
  assert.throws(
    () => kaplan.parseResponses({ results: [], expectedVariants: 1 }),
    /Kaplan proxy returned no fulfilled results/
  );
});

test('kaplan_proxy.parseResponses throws for failed or mixed results and never relays provider text', () => {
  const failedProviderText = 'provider exploded in a bucket';
  const validResult = { ok: true, body: { images: [], costUsd: 0 } };
  const cases = [
    { results: [{ ok: false, status: 500, error: new Error(failedProviderText) }], expectedVariants: 1 },
    { results: [validResult, { ok: false, status: 500, error: new Error(failedProviderText) }], expectedVariants: 1 }
  ];

  for (const input of cases) {
    let threw = false;
    try {
      kaplan.parseResponses(input);
    } catch (error) {
      threw = true;
      assert.match(error.message, /did not fulfill cleanly/);
      assert.ok(!error.message.includes(failedProviderText));
    }
    assert.ok(threw, 'expected parseResponses to throw for this input');
  }
});

test('kaplan_proxy.parseResponses throws when a fulfilled body is missing or malformed', () => {
  assert.throws(
    () => kaplan.parseResponses({ results: [{ ok: true }], expectedVariants: 1 }),
    /without a parseable body/
  );
  assert.throws(
    () => kaplan.parseResponses({ results: [{ ok: true, body: null }], expectedVariants: 1 }),
    /without a parseable body/
  );
  assert.throws(
    () => kaplan.parseResponses({ results: [{ ok: true, body: 'not object' }], expectedVariants: 1 }),
    /without a parseable body/
  );
});

test('kaplan_proxy.parseResponses throws on missing/invalid costUsd', () => {
  const invalidCosts = [undefined, null, '0.03', NaN, Infinity, -0.01];
  for (const cost of invalidCosts) {
    const body = { images: [] };
    if (cost !== undefined) body.costUsd = cost;
    assert.throws(
      () => kaplan.parseResponses({ results: [{ ok: true, body }], expectedVariants: 1 }),
      /valid numeric costUsd/,
      `expected costUsd=${String(cost)} to be rejected`
    );
  }

  // Aggregate overflow is also unaccounted.
  assert.throws(
    () => kaplan.parseResponses({
      results: [
        { ok: true, body: { images: [], costUsd: Number.MAX_VALUE } },
        { ok: true, body: { images: [], costUsd: Number.MAX_VALUE } }
      ],
      expectedVariants: 1
    }),
    /cost total is not finite/
  );
});

test('kaplan_proxy.parseResponses rejects expectedVariants outside integer 1..4', () => {
  for (const expectedVariants of [undefined, 0, 5, 1.5, '2', false]) {
    assert.throws(
      () => kaplan.parseResponses({ results: [], expectedVariants }),
      /expectedVariants to be an integer between 1 and 4/,
      `expectedVariants=${String(expectedVariants)} should be invalid`
    );
  }
});
