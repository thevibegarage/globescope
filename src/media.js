import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from './db.js';
import { resolveImageUrl } from './resolvers.js';
import { config } from './config.js';

// Upstream camera feeds are a mess: mixed HTTP/HTTPS, no CORS headers, hotlink
// checks on Referer. Everything the browser loads therefore goes through here.
//
// This proxy also stands between a potentially large audience and a few dozen
// public agency servers, so it is built to absorb load rather than relay it:
// one upstream request per camera per interval however many people are
// watching, validators so repeat viewers get a 304, and cache directives an
// edge can act on. See "Caching and the CDN" in the README.

const camStmt = db.prepare('SELECT * FROM cameras WHERE id = ?');
export const getCam = (id) => camStmt.get(id);

const frames = new Map();   // id -> { id, buf, ct, etag, fetchedAt, modifiedAt }
const inflight = new Map(); // id -> Promise<entry>
const failures = new Map(); // id -> { at, status, message }
let cachedBytes = 0;

// Refetching faster than a provider publishes costs an agency bandwidth for a
// picture we already have. The registry records each source's stated cadence,
// so the cache lifetime follows the camera rather than one global guess.
const ttlFor = (cam) =>
  Math.min(Math.max(Number(cam.refresh_sec) || 0, config.frameCacheSec), config.frameMaxCacheSec);

// The client asks for one URL per camera per refresh window (see frameUrl in
// public/app.js), so the browser may hold a frame for the whole window too:
// the next window is a different URL, not a revalidation.
const cacheControlFor = (ttl) => [
  'public',
  `max-age=${ttl}`,
  `s-maxage=${ttl}`,
  `stale-while-revalidate=${config.frameStaleRevalidateSec}`,
  `stale-if-error=${config.frameStaleErrorSec}`,
].join(', ');

const ERROR_CACHE_CONTROL =
  `public, max-age=${config.frameErrorCacheSec}, s-maxage=${config.frameErrorCacheSec}`;

function touch(entry) {
  // Map iterates in insertion order, so re-inserting the key makes eviction
  // least-recently-used. The identity check matters because a caller may be
  // holding an entry that has already been replaced or evicted.
  if (frames.get(entry.id) !== entry) return;
  frames.delete(entry.id);
  frames.set(entry.id, entry);
}

function remember(entry) {
  const prev = frames.get(entry.id);
  if (prev) { cachedBytes -= prev.buf.length; frames.delete(entry.id); }
  frames.set(entry.id, entry);
  cachedBytes += entry.buf.length;
  // Budgeted in bytes, not entries: one 8 MB frame is worth eighty ordinary
  // ones, and an entry count alone would let a few of them exhaust the box.
  for (const [id, old] of frames) {
    if (cachedBytes <= config.frameCacheBytes) break;
    if (id === entry.id) continue;
    frames.delete(id);
    cachedBytes -= old.buf.length;
  }
}

function forget(entry) {
  if (frames.get(entry.id) !== entry) return;
  frames.delete(entry.id);
  cachedBytes -= entry.buf.length;
}

const MAGIC = [
  [0xff, 0xd8, 0xff],                   // jpeg
  [0x89, 0x50, 0x4e, 0x47],             // png
  [0x47, 0x49, 0x46, 0x38],             // gif
];
function isImageBytes(buf) {
  if (buf.length < 12) return false;
  if (MAGIC.some((sig) => sig.every((b, i) => buf[i] === b))) return true;
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

function upstreamHeaders(cam, extra = {}) {
  return {
    'User-Agent': config.userAgent,
    Accept: 'image/avif,image/webp,image/*,video/*,*/*',
    ...(cam.page_url ? { Referer: cam.page_url } : {}),
    ...extra,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const lastModifiedOf = (r) => {
  const t = Date.parse(r.headers.get('last-modified') || '');
  return Number.isFinite(t) ? t : null;
};

async function fetchUpstream(cam) {
  // Sources with expiring, token-signed URLs mint a fresh one here.
  const target = await resolveImageUrl(cam);
  if (!target) throw httpError(502, 'could not resolve image url');

  const r = await fetch(target, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.healthTimeoutMs),
    headers: upstreamHeaders(cam),
  });
  if (!r.ok) { await r.body?.cancel(); throw httpError(502, `upstream ${r.status}`); }

  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > config.maxFrameBytes) throw httpError(502, 'frame too large');

  const upstreamCt = r.headers.get('content-type') || '';
  // Some providers send image bytes as application/octet-stream, so trust the
  // magic number too — but never relabel a JSON error page as an image.
  if (!upstreamCt.startsWith('image/') && !isImageBytes(buf)) {
    throw httpError(502, 'upstream did not return an image');
  }

  const etag = `"${createHash('sha1').update(buf).digest('base64url')}"`;
  const prev = frames.get(cam.id);
  const now = Date.now();
  const entry = {
    id: cam.id,
    buf,
    ct: upstreamCt.startsWith('image/') ? upstreamCt : 'image/jpeg',
    etag,
    fetchedAt: now,
    // Most cameras refresh far more slowly than the map polls them, so an
    // unchanged frame keeps its original timestamp and every viewer already
    // holding it goes on answering itself.
    modifiedAt: prev?.etag === etag ? prev.modifiedAt : (lastModifiedOf(r) ?? now),
  };
  remember(entry);
  failures.delete(cam.id);
  return entry;
}

function fetchFrame(cam) {
  // Fifty people opening the same camera at once must become one request to
  // the agency, not fifty. Without this the cache only helps *after* a spike.
  const pending = inflight.get(cam.id);
  if (pending) return pending;

  const p = fetchUpstream(cam)
    .catch((err) => {
      noteFailure(cam.id, err.status || 504, err.message);
      throw err;
    })
    .finally(() => inflight.delete(cam.id));
  inflight.set(cam.id, p);
  // Every caller attaches its own handler, but a rejection must not surface as
  // an unhandled one if the last of them disconnects first.
  p.catch(() => {});
  return p;
}

function noteFailure(id, status, message) {
  failures.set(id, { at: Date.now(), status, message });
  // Browsing enough dead cameras would otherwise grow this map without limit.
  // Anything past the error window is already ignored, so it can simply go.
  if (failures.size > 5000) {
    const cutoff = Date.now() - config.frameErrorCacheSec * 1000;
    for (const [k, v] of failures) if (v.at < cutoff) failures.delete(k);
  }
}

function sendFrame(req, res, entry, ttl, state) {
  touch(entry);
  res.set({
    'Content-Type': entry.ct,
    'Cache-Control': cacheControlFor(ttl),
    ETag: entry.etag,
    'Last-Modified': new Date(entry.modifiedAt).toUTCString(),
    'X-Cache': state,
  });
  // A camera that has not moved costs a couple of hundred bytes to re-serve
  // instead of a whole JPEG; req.fresh compares the validators just set.
  if (req.fresh) return res.status(304).end();
  res.end(entry.buf);
}

function sendError(res, status, detail) {
  // Negative answers are cached briefly too: a camera that is down stays down
  // for longer than one request, and the edge should absorb the repeats.
  res.set('Cache-Control', ERROR_CACHE_CONTROL);
  res.status(status).json({ error: detail });
}

export async function serveFrame(req, res) {
  const cam = getCam(req.params.id);
  if (!cam || !cam.image_url) return res.status(404).json({ error: 'no such camera image' });

  const now = Date.now();
  const ttl = ttlFor(cam);
  let hit = frames.get(cam.id);
  if (hit && now - hit.fetchedAt > config.frameCacheGraceSec * 1000) { forget(hit); hit = undefined; }
  if (hit && now - hit.fetchedAt < ttl * 1000) return sendFrame(req, res, hit, ttl, 'HIT');

  const fail = failures.get(cam.id);
  if (fail && now - fail.at < config.frameErrorCacheSec * 1000) {
    // Leave the upstream alone, but an old picture still beats an error page.
    if (hit) return sendFrame(req, res, hit, ttl, 'STALE');
    return sendError(res, fail.status, fail.message);
  }

  try {
    return sendFrame(req, res, await fetchFrame(cam), ttl, 'MISS');
  } catch (err) {
    // stale-if-error, applied here and not only at the edge.
    if (hit) return sendFrame(req, res, hit, ttl, 'STALE');
    return sendError(res, err.status || 504, err.message);
  }
}

/** Cache occupancy, for /healthz. */
export const frameCacheStats = () => ({
  entries: frames.size,
  bytes: cachedBytes,
  inflight: inflight.size,
  failing: failures.size,
});

/** Rewrite an HLS playlist so every segment and child playlist comes back to us. */
export async function serveHls(req, res) {
  const cam = getCam(req.params.id);
  if (!cam?.stream_url) return res.status(404).json({ error: 'no stream for camera' });

  const target = req.query.u ? decodeURIComponent(req.query.u) : cam.stream_url;
  if (!sameOrigin(target, cam.stream_url)) return res.status(403).json({ error: 'off-origin' });

  try {
    const r = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.healthTimeoutMs),
      headers: upstreamHeaders(cam),
    });
    if (!r.ok) { await r.body?.cancel(); return res.status(502).json({ error: `upstream ${r.status}` }); }

    const text = await r.text();
    const base = new URL(target);
    const rewritten = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        // Keyed/aux URIs live inside tag attributes.
        return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxyUrl(cam.id, u, base)}"`);
      }
      return proxyUrl(cam.id, t, base);
    }).join('\n');

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    // A live playlist turns over once per segment; two seconds is well inside
    // that window and still collapses a crowd arriving together into one fetch.
    res.set('Cache-Control', 'public, max-age=2, s-maxage=2');
    res.end(rewritten);
  } catch (err) {
    res.status(504).json({ error: 'upstream timeout', detail: err.message });
  }
}

// Child playlists need rewriting again; segments and key files are raw bytes
// and must go to the streaming route instead.
const proxyUrl = (id, ref, base) => {
  const abs = new URL(ref, base).href;
  const route = /\.m3u8(\?|$)/i.test(abs) ? 'hls' : 'clip';
  return `/${route}/${encodeURIComponent(id)}?u=${encodeURIComponent(abs)}`;
};

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// A segment URL names fixed bytes for as long as it stays in the live window,
// so a brief cache is safe and this is where most of the video bytes are. A
// partial response is left alone: range caching is not worth the edge cases.
const SEGMENT_RE = /\.(ts|m4s|mp4|aac)(\?|$)/i;

/** Byte-range passthrough for MP4 clips and MPEG-TS segments. */
export async function serveClip(req, res) {
  const cam = getCam(req.params.id);
  if (!cam?.stream_url) return res.status(404).json({ error: 'no stream for camera' });

  const target = req.query.u ? decodeURIComponent(req.query.u) : cam.stream_url;
  if (!sameOrigin(target, cam.stream_url)) return res.status(403).json({ error: 'off-origin' });

  try {
    const r = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: upstreamHeaders(cam, req.headers.range ? { Range: req.headers.range } : {}),
    });
    res.status(r.status);
    for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const v = r.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set('Cache-Control',
      r.status === 200 && SEGMENT_RE.test(target) ? 'public, max-age=10' : 'no-store');
    if (!r.body) return res.end();
    // pipeline honours backpressure; a plain write loop would buffer the whole
    // segment in memory if the client reads slowly.
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    res.status(504).json({ error: 'upstream timeout', detail: err.message });
  }
}
