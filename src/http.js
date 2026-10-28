import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export async function fetchText(url, { timeout = 30000, retries = 2, onResponse, ...opts } = {}) {
  opts.onResponse = onResponse;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { onResponse: _hook, ...init } = opts;
      const res = await fetch(url, {
        ...init,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
        headers: {
          'User-Agent': config.userAgent,
          'Accept-Encoding': 'gzip, deflate',
          ...(opts.headers || {}),
        },
      });
      if (!res.ok) {
        const err = new HttpError(res.status, url);
        if (res.status === 429) {
          // Honour the server's own pacing instruction rather than guessing.
          const after = parseFloat(res.headers.get('retry-after'))
            || parseFloat(res.headers.get('x-ratelimit-reset')) || 5;
          err.retryAfterMs = Math.min(Math.max(after, 1), 30) * 1000;
        }
        throw err;
      }
      if (opts.onResponse) opts.onResponse(res);
      return await res.text();
    } catch (err) {
      lastErr = err;
      // 4xx other than 429 will not get better by trying again.
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) break;
      if (attempt < retries) {
        await sleep(err.retryAfterMs ?? 1200 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with bounded concurrency, preserving input order in the result. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { error: err };
      }
    }
  });
  await Promise.all(runners);
  return out;
}
