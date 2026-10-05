import {
  buildVertexRequest,
  parseVertexResponse,
  estimateCostUsd
} from './core.mjs';

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_TIMEOUT_MS = 10000;
const VERTEX_TIMEOUT_MS = 120000;

function createTimeoutError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  return await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function defaultGetAccessToken(fetchImpl) {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      METADATA_TOKEN_URL,
      {
        method: 'GET',
        headers: {
          'Metadata-Flavor': 'Google'
        },
        redirect: 'error'
      },
      METADATA_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error('metadata token fetch failed');
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('metadata token fetch failed');
    }

    const token = data?.access_token;
    const tokenType = data?.token_type;
    if (typeof token !== 'string' || token.length === 0 || tokenType !== 'Bearer') {
      throw new Error('metadata token fetch failed');
    }

    return token;
  } catch {
    throw createTimeoutError('Token fetch failed', 'TOKEN_ERROR');
  }
}

export function createVertexClient({ config, fetchImpl, getAccessToken }) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('config is required');
  }

  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new TypeError('fetch implementation is required');
  }

  const tokenSource =
    typeof getAccessToken === 'function' ? getAccessToken : () => defaultGetAccessToken(fetcher);

  return {
    async generate(input) {
      if (!input || typeof input !== 'object') {
        throw createTimeoutError('Invalid input', 'VERTEX_ERROR');
      }
      if (
        typeof input.prompt !== 'string' ||
        input.prompt.length === 0 ||
        !Number.isInteger(input.variants) ||
        input.variants < 1 ||
        input.variants > 4
      ) {
        throw createTimeoutError('Invalid input', 'VERTEX_ERROR');
      }

      let token;
      try {
        token = await tokenSource();
      } catch {
        throw createTimeoutError('Token fetch failed', 'TOKEN_ERROR');
      }

      if (typeof token !== 'string' || token.length === 0) {
        throw createTimeoutError('Token fetch failed', 'TOKEN_ERROR');
      }

      const images = [];
      let failureCount = 0;
      let blockedCount = 0;
      let emptyCount = 0;

      for (let index = 0; index < input.variants; index += 1) {
        let request;
        try {
          request = buildVertexRequest(
            {
              prompt: input.prompt,
              model: input.model,
              variants: 1
            },
            config
          );
        } catch {
          failureCount += 1;
          continue;
        }

        try {
          const response = await fetchWithTimeout(
            fetcher,
            request.url,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(request.body),
              redirect: 'error'
            },
            VERTEX_TIMEOUT_MS
          );

          if (!response.ok) {
            failureCount += 1;
            continue;
          }

          let data;
          try {
            data = await response.json();
          } catch {
            failureCount += 1;
            continue;
          }

          try {
            const parsed = parseVertexResponse(data);
            if (parsed.images.length > 0) {
              images.push(...parsed.images);
            }
            if (parsed.blocked === true) {
              blockedCount += 1;
            }
          } catch (error) {
            if (error && error.code === 'NO_IMAGES') {
              emptyCount += 1;
            } else {
              failureCount += 1;
            }
          }
        } catch {
          failureCount += 1;
        }
      }

      const imageCount = images.length;

      if (imageCount === 0) {
        if (failureCount > 0) {
          throw createTimeoutError('Image generation failed', 'VERTEX_ERROR');
        }

        if (emptyCount > 0) {
          if (blockedCount > 0) {
            throw createTimeoutError('Vertex API error', 'VERTEX_ERROR');
          }
          throw createTimeoutError('No images returned', 'NO_IMAGES');
        }

        if (blockedCount > 0) {
          return {
            images: [],
            costUsd: 0,
            blocked: true,
            blockReason: 'SAFETY',
            partial: false
          };
        }

        throw createTimeoutError('No images returned', 'NO_IMAGES');
      }

      const costUsd = estimateCostUsd(imageCount, config.location);
      const partial = failureCount > 0 || blockedCount > 0 || emptyCount > 0;

      return {
        images,
        costUsd,
        blocked: false,
        blockReason: null,
        partial
      };
    }
  };
}
