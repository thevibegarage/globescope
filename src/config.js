import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Load .env if present so secrets can be added without editing a service unit.
// Real environment variables always win over the file.
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`[config] could not read ${envFile}: ${err.message}`);
  }
}

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  port: int(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'opencam.db'),

  // Background jobs
  ingestIntervalMin: int(process.env.INGEST_INTERVAL_MIN, 180),
  healthConcurrency: int(process.env.HEALTH_CONCURRENCY, 48),
  // Parallel probes allowed against a single upstream host. Batches often cover
  // one source, so this — not the global cap — sets real sweep throughput.
  healthPerHost: int(process.env.HEALTH_PER_HOST, 8),
  healthIntervalMin: int(process.env.HEALTH_INTERVAL_MIN, 20),
  healthTimeoutMs: int(process.env.HEALTH_TIMEOUT_MS, 12000),

  // A camera still serving an identical frame for longer than this is "frozen".
  staleAfterMin: int(process.env.STALE_AFTER_MIN, 90),
  // Consecutive failures before a camera is dropped from the live map.
  offlineAfterFails: int(process.env.OFFLINE_AFTER_FAILS, 2),

  // Proxy cache: how long a fetched frame is reused before refetching upstream.
  frameCacheSec: int(process.env.FRAME_CACHE_SEC, 8),
  maxFrameBytes: int(process.env.MAX_FRAME_BYTES, 8 * 1024 * 1024),

  // Optional sources that need credentials.
  windyApiKey: process.env.WINDY_API_KEY || '',
  // Country shards for Windy; each stays under the free tier's 1000 offset cap.
  windyCountries: (process.env.WINDY_COUNTRIES || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  userAgent:
    process.env.USER_AGENT ||
    'OpenCam/1.0 (public webcam aggregator; +https://github.com/your/opencam)',

  disabledSources: (process.env.DISABLED_SOURCES || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
};
