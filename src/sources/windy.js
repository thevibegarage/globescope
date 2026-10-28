import { fetchJson, sleep } from '../http.js';
import { config } from '../config.js';
import { registerResolver } from '../resolvers.js';

// Optional global source: tourism, civic and coastal webcams worldwide.
// Free key: https://api.windy.com/keys  ->  set WINDY_API_KEY.
//
// Three free-tier facts shape this adapter:
//   1. image URLs are token-signed and expire after 10 minutes (401 after
//      that), so a URL captured at ingest is useless later — hence the
//      resolver at the bottom of this file;
//   2. listing offset is capped at 1000, so no single query can return more
//      than ~1000 webcams however large the result set is;
//   3. the catalogue is ~69k webcams, far more than that cap.
// So the sweep shards by country, and any country holding more than the cap is
// split again by its regions. Both lists come from the API itself.
const V3 = 'https://api.windy.com/webcams/api/v3';
const API = `${V3}/webcams`;
const PAGE = 50;
const MAX_OFFSET = 1000;
const SHARD_WORKERS = 1; // the gate serialises anyway; keep the planner simple

const headers = () => ({ 'x-windy-api-key': config.windyApiKey, Accept: 'application/json' });

// The API reports its budget in x-ratelimit-* headers (300 per rolling window).
// Requests are serialised through one gate that paces itself from those
// numbers, which is why the sweep uses a single worker.
const MIN_GAP_MS = 260;
let gate = Promise.resolve();
let nextAllowedAt = 0;
let budget = { remaining: Infinity, resetSec: 0 };

function noteHeaders(res) {
  const rem = parseInt(res.headers.get('x-ratelimit-remaining'), 10);
  const rst = parseInt(res.headers.get('x-ratelimit-reset'), 10);
  if (Number.isFinite(rem)) budget.remaining = rem;
  if (Number.isFinite(rst)) budget.resetSec = rst;
}

function get(path, opts = {}) {
  const run = async () => {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    // Running low on budget: sit out the rest of the window rather than 429.
    if (budget.remaining <= 15 && budget.resetSec > 0) {
      await sleep((budget.resetSec + 1) * 1000);
      budget.remaining = Infinity;
    }
    nextAllowedAt = Date.now() + MIN_GAP_MS;
    return fetchJson(V3 + path, {
      timeout: 25000, retries: 3, headers: headers(), onResponse: noteHeaders, ...opts,
    });
  };
  gate = gate.then(run, run);
  return gate;
}

function mapWebcam(w, countryCode) {
  const loc = w.location || {};
  if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
  const img = w.images?.current?.preview || w.images?.current?.thumbnail || null;

  return {
    id: `windy:${w.webcamId}`,
    source: 'windy',
    native_id: String(w.webcamId),
    name: w.title || `Webcam ${w.webcamId}`,
    lat: loc.latitude,
    lon: loc.longitude,
    country: countryCode || null,  // Windy returns a name; store the ISO code like every other source
    region: loc.region || null,
    locality: loc.city || null,
    kind: 'scenic',
    // Present only so the camera counts as having an image; the resolver
    // replaces it on every view because this URL dies within 10 minutes.
    image_url: img || `${API}/${w.webcamId}`,
    stream_url: null,
    page_url: w.urls?.detail || 'https://www.windy.com/webcams',
    refresh_sec: 300,
    provider_state: w.status === 'active' ? 'up' : 'down',
  };
}

/** Page through one filter slice, stopping at the free tier's offset ceiling. */
async function pullSlice(query, countryCode, sink) {
  let offset = 0;
  while (offset <= MAX_OFFSET) {
    const json = await get(`/webcams?limit=${PAGE}&offset=${offset}&include=location,images,urls${query}`);
    const batch = json.webcams || [];
    for (const w of batch) {
      const row = mapWebcam(w, countryCode);
      if (row) sink.set(row.id, row);
    }
    offset += PAGE;
    if (batch.length < PAGE) break;
    if (json.total != null && offset >= json.total) break;
  }
}

const countOf = async (query) => (await get(`/webcams?limit=1${query}`)).total ?? 0;

export default {
  id: 'windy',
  label: 'Windy Webcams — worldwide',
  attribution: 'windy.com webcams',
  license: 'Windy Webcams API terms (free tier: link or embed back to windy.com)',
  home: 'https://www.windy.com/webcams',

  // Liveness comes from the API's own `status` field. Probing images here would
  // mean one URL-minting call plus one image fetch per camera per sweep — tens
  // of thousands of extra requests against a free key, for information the
  // provider already gives us at ingest.
  skipHealthProbe: true,

  get enabled() {
    return Boolean(config.windyApiKey);
  },

  async fetchAll() {
    if (!config.windyApiKey) return [];

    const picked = config.windyCountries;
    const countries = picked.length
      ? picked
      : (await get('/countries')).map((c) => c.code).filter(Boolean);
    const allRegions = (await get('/regions')).map((r) => r.code).filter(Boolean);

    // Build the shard list first so oversized countries are split before any
    // paging starts.
    const shards = [];
    let qi = 0;
    const planner = async () => {
      while (qi < countries.length) {
        const cc = countries[qi++];
        try {
          const total = await countOf(`&countries=${cc}`);
          if (total === 0) continue;
          if (total <= MAX_OFFSET) { shards.push({ q: `&countries=${cc}`, cc }); continue; }

          const regions = allRegions.filter((r) => r.startsWith(`${cc}.`));
          if (!regions.length) {
            // Nothing to split by; take the first 1000 and say so.
            console.warn(`[windy] ${cc} has ${total} webcams and no regions — capped at ${MAX_OFFSET}`);
            shards.push({ q: `&countries=${cc}`, cc });
            continue;
          }
          for (const r of regions) shards.push({ q: `&regions=${r}`, cc });
        } catch (err) {
          console.warn(`[windy] counting ${cc} failed: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: SHARD_WORKERS }, planner));

    const byId = new Map();
    let si = 0;
    const puller = async () => {
      while (si < shards.length) {
        const { q, cc } = shards[si++];
        try { await pullSlice(q, cc, byId); }
        catch (err) { console.warn(`[windy] slice ${q} failed: ${err.message}`); }
      }
    };
    await Promise.all(Array.from({ length: SHARD_WORKERS }, puller));

    console.log(`[windy] ${shards.length} shards -> ${byId.size} unique webcams`);
    return [...byId.values()];
  },
};

// Free-tier image URLs last 10 minutes, so mint a fresh one per view and cache
// it well inside that window.
const FRESH_MS = 7 * 60 * 1000;
const cache = new Map();

registerResolver('windy', async (cam) => {
  const hit = cache.get(cam.native_id);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.url;

  const json = await get(`/webcams/${cam.native_id}?include=images`, { timeout: 15000 });
  const w = json.webcam || json;
  const url = w.images?.current?.preview || w.images?.current?.thumbnail || null;

  if (url) {
    cache.set(cam.native_id, { url, at: Date.now() });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
  }
  return url;
});
