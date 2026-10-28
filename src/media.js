import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from './db.js';
import { resolveImageUrl } from './resolvers.js';
import { config } from './config.js';

// Upstream camera feeds are a mess: mixed HTTP/HTTPS, no CORS headers, hotlink
// checks on Referer. Everything the browser loads therefore goes through here.

const camStmt = db.prepare('SELECT * FROM cameras WHERE id = ?');
export const getCam = (id) => camStmt.get(id);

const frames = new Map(); // id -> { buf, ct, at }
const MAX_CACHED = 600;

function remember(id, entry) {
  frames.set(id, entry);
  if (frames.size > MAX_CACHED) {
    // Map preserves insertion order, so the oldest key is first.
    for (const k of frames.keys()) { frames.delete(k); if (frames.size <= MAX_CACHED) break; }
  }
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

export async function serveFrame(req, res) {
  const cam = getCam(req.params.id);
  if (!cam || !cam.image_url) return res.status(404).json({ error: 'no such camera image' });

  const hit = frames.get(cam.id);
  if (hit && Date.now() - hit.at < config.frameCacheSec * 1000) {
    res.set('Content-Type', hit.ct);
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', `public, max-age=${config.frameCacheSec}`);
    return res.end(hit.buf);
  }

  try {
    // Sources with expiring, token-signed URLs mint a fresh one here.
    const target = await resolveImageUrl(cam);
    if (!target) return res.status(502).json({ error: 'could not resolve image url' });

    const r = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.healthTimeoutMs),
      headers: upstreamHeaders(cam),
    });
    if (!r.ok) { await r.body?.cancel(); return res.status(502).json({ error: `upstream ${r.status}` }); }

    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > config.maxFrameBytes) return res.status(502).json({ error: 'frame too large' });

    const upstreamCt = r.headers.get('content-type') || '';
    // Some providers send image bytes as application/octet-stream, so trust the
    // magic number too — but never relabel a JSON error page as an image.
    if (!upstreamCt.startsWith('image/') && !isImageBytes(buf)) {
      return res.status(502).json({ error: 'upstream did not return an image' });
    }
    const ct = upstreamCt.startsWith('image/') ? upstreamCt : 'image/jpeg';

    remember(cam.id, { buf, ct, at: Date.now() });
    res.set('Content-Type', ct);
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', `public, max-age=${config.frameCacheSec}`);
    res.end(buf);
  } catch (err) {
    res.status(504).json({ error: 'upstream timeout', detail: err.message });
  }
}

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
    res.set('Cache-Control', 'no-store');
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
    res.set('Cache-Control', 'no-store');
    if (!r.body) return res.end();
    // pipeline honours backpressure; a plain write loop would buffer the whole
    // segment in memory if the client reads slowly.
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    res.status(504).json({ error: 'upstream timeout', detail: err.message });
  }
}
