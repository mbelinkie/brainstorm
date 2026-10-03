# Kaplan Image Proxy

Single-purpose HTTP service for generating Gemini images with a rough cost estimate.

## Environment

- `GOOGLE_CLOUD_PROJECT` (optional): GCP project ID. Defaults to `quiz-platform-image-generation`. Must match project-id pattern.
- `VERTEX_LOCATION` (required): one of `global`, `us`, or `eu`. No default. The deployer must choose the explicitly approved serving location for `gemini-3.1-flash-image`; this service never guesses.
- `PROXY_SHARED_SECRET` (required): exact shared bearer secret used by the application. No default.
- `PORT` (optional): decimal integer 1-65535. Defaults to `8080`.

No `.env` files or service-account key files are read. Vertex credentials come from the Cloud Run attached service account via the metadata server; no key file is used.

## Start

Direct execution:

```
node server.mjs
```

The server listens on `0.0.0.0:$PORT`. Importing the module does not start a listener.

Invalid startup configuration exits non-zero before any network call and prints only a safe configuration reason.

## Authentication

The service expects an `Authorization: Bearer <PROXY_SHARED_SECRET>` header. The comparison uses a constant-time digest to avoid secret-length timing. Cloud Run can expose the service to unauthenticated ingress because the proxy itself enforces this application-level shared secret.

## API

`POST /generate`

- Content-Type must be `application/json` (parameters such as `charset=utf-8` are accepted).
- Request body is capped at 65536 bytes.
- Body must be an object with exactly these keys:

```json
{
  "prompt": "string, nonblank, max 2000 UTF-16 code units",
  "model": "gemini-3.1-flash-image",
  "variants": 1
}
```

- `model` must be exactly `gemini-3.1-flash-image`.
- `variants` must be an integer from 1 to 4.

Example:

```bash
curl -X POST "$PROXY_URL/generate" \
  -H "Authorization: Bearer $PROXY_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"prompt":"a placeholder prompt","model":"gemini-3.1-flash-image","variants":2}'
```

Success response includes `images` (array of `{mimeType, bytesBase64}`), `costUsd`, `blocked`, `blockReason`, and `partial`. Error responses are structured as `{"error":{"code":"...","message":"..."}}`.

Statuses include 400 invalid body, 401 auth, 404 unknown path, 405 wrong method, 413 oversized, 415 unsupported type, 502 sanitized provider error. Responses include `Cache-Control: no-store`.

## Cost estimate

This service returns a rough image-output estimate, not an invoice. The estimate uses dated Vertex AI Standard PayGo image output pricing for a fixed 1K image size, as of 2026-10-02:

- Global: `$0.0672` per returned image.
- Non-global (`us`/`eu`): `$0.07392` per returned image.

Formula: `imageCount * rate`.

The estimate excludes input tokens, text/reasoning output, billing rounding, and account-specific pricing. Actual billing must be compared during the authorized internal Kaplan pilot. See:
- https://cloud.google.com/vertex-ai/generative-ai/pricing
- https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image

## Tests

Run all tests with:

```
npm test
```

The proxy tests live in `test/kaplan-proxy.test.js` (uses Node's built-in test runner). The test file is added in the sibling test slice; do not rely on it being present during intermediate artifact review.

## Container

`Dockerfile` is a runtime-only Node 24 image, non-root user, copies only `core.mjs`, `vertex.mjs`, and `server.mjs`, and starts `node server.mjs` on port 8080. No npm install, build dependencies, or cloud secrets are included. Container build and deployment are handled by the separate Cloud Run deploy issue.

## Security boundaries

- Only `POST /generate`; no static/file proxy and no arbitrary upstream routing.
- Prompts, authorization headers, tokens, and raw upstream errors are never logged.
- The service never reads `.env` files, never uses a service-account key file, and never stores prompts.
