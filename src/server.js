import express from 'express';
import zlib from 'node:zlib';
import path from 'node:path';
import { db } from './db.js';
import { config, ROOT } from './config.js';
import { activeSources } from './sources/index.js';
import { serveFrame, serveHls, serveClip, frameCacheStats } from './media.js';
import { startIngestLoop } from './jobs/ingest.js';
import { startHealthLoop } from './jobs/health.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/** Compress JSON responses; the points payload is the only big one. */
app.use((req, res, next) => {
  const accepts = (req.headers['accept-encoding'] || '').includes('gzip');
  const json = res.json.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    if (!accepts || text.length < 2048) return json(body);
    const buf = zlib.gzipSync(text, { level: 6 });
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    return res.end(buf);
  };
  next();
});

const LIVE = ['online', 'stale'];
const parseList = (v, allowed) =>
  String(v || '').split(',').map((s) => s.trim()).filter((s) => allowed.includes(s));

function statusFilter(q) {
  const wanted = parseList(q.status, ['online', 'stale', 'offline', 'unknown']);
  return wanted.length ? wanted : LIVE;
}

// ---------------------------------------------------------------- API

app.get('/healthz', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  res.json({
    ok: true,
    cameras: total,
    uptime: Math.round(process.uptime()),
    frameCache: frameCacheStats(),
  });
});

app.get('/api/meta', (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM cameras GROUP BY status').all();
  const bySource = db.prepare(`
    SELECT source,
           COUNT(*) total,
           SUM(CASE WHEN status='online' THEN 1 ELSE 0 END) online,
           SUM(CASE WHEN status='stale'  THEN 1 ELSE 0 END) stale
      FROM cameras GROUP BY source ORDER BY total DESC`).all();
  const lastIngest = db.prepare(
    `SELECT source, started_at, ended_at, ok, found, note FROM runs
      WHERE job='ingest' ORDER BY started_at DESC LIMIT 12`).all();
  const lastHealth = db.prepare(
    `SELECT started_at, ended_at, found, note FROM runs
      WHERE job='health' ORDER BY started_at DESC LIMIT 1`).get();

  const labels = Object.fromEntries(
    activeSources().map((s) => [s.id, { label: s.label, attribution: s.attribution, license: s.license, home: s.home }])
  );
  const placeholders = db.prepare(
    "SELECT COUNT(*) c FROM cameras WHERE provider_state='placeholder'").get().c;

  res.json({
    counts: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
    total: byStatus.reduce((a, r) => a + r.c, 0),
    placeholders,
    signatures: db.prepare('SELECT COUNT(*) c FROM placeholder_sigs').get().c,
    bySource, labels, lastIngest, lastHealth,
    serverTime: Date.now(),
  });
});

/** Compact payload for the map: the whole live set in one gzipped response. */
app.get('/api/points', (req, res) => {
  const statuses = statusFilter(req.query);
  const marks = statuses.map(() => '?').join(',');
  const params = [...statuses];

  let sql = `SELECT rowid AS n, name, lat, lon, kind, status, source
               FROM cameras WHERE status IN (${marks})`;
  if (req.query.source) {
    const srcs = String(req.query.source).split(',').filter(Boolean);
    sql += ` AND source IN (${srcs.map(() => '?').join(',')})`;
    params.push(...srcs);
  }
  if (req.query.kind) {
    const kinds = String(req.query.kind).split(',').filter(Boolean);
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }

  const rows = db.prepare(sql).all(...params);

  // This is the one payload that scales with the whole dataset, so it is kept
  // narrow: no names (the detail call supplies those), 4-decimal coordinates
  // (~11 m, finer than any marker needs) and dictionary-encoded enums.
  const kindDict = [];
  const statusDict = [];
  const idx = (arr, v) => {
    let i = arr.indexOf(v);
    if (i < 0) { i = arr.length; arr.push(v); }
    return i;
  };

  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    cols: ['n', 'lat', 'lon', 'k', 's'],
    kinds: kindDict,
    statuses: statusDict,
    rows: rows.map((r) => [
      r.n, +r.lat.toFixed(4), +r.lon.toFixed(4),
      idx(kindDict, r.kind), idx(statusDict, r.status),
    ]),
    t: Date.now(),
  });
});

const byRowid = db.prepare('SELECT *, rowid AS n FROM cameras WHERE rowid = ?');
const byId    = db.prepare('SELECT *, rowid AS n FROM cameras WHERE id = ?');

function shape(c) {
  if (!c) return null;
  return {
    id: c.id, n: c.n, source: c.source, name: c.name,
    lat: c.lat, lon: c.lon,
    country: c.country, region: c.region, locality: c.locality,
    kind: c.kind, status: c.status, refresh_sec: c.refresh_sec,
    has_image: Boolean(c.image_url),
    has_stream: Boolean(c.stream_url),
    stream_kind: c.stream_url ? (/\.m3u8(\?|$)/i.test(c.stream_url) ? 'hls' : 'mp4') : null,
    image: c.image_url ? `/img/${encodeURIComponent(c.id)}` : null,
    stream: c.stream_url
      ? (/\.m3u8(\?|$)/i.test(c.stream_url) ? `/hls/${encodeURIComponent(c.id)}` : `/clip/${encodeURIComponent(c.id)}`)
      : null,
    page_url: c.page_url, attribution: c.attribution, license: c.license,
    checked_at: c.checked_at, ok_at: c.ok_at, changed_at: c.changed_at, bytes: c.bytes,
  };
}

app.get('/api/camera/n/:n', (req, res) => {
  const c = byRowid.get(parseInt(req.params.n, 10));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(shape(c));
});

app.get('/api/camera/:id', (req, res) => {
  const c = byId.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(shape(c));
});

/** Cameras inside a bounding box, nearest the centre first — powers the sidebar. */
app.get('/api/cameras', (req, res) => {
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    return res.status(400).json({ error: 'bbox=west,south,east,north required' });
  }
  const [w, s, e, n] = bbox;
  const statuses = statusFilter(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 300, 2000);
  const cx = (w + e) / 2, cy = (s + n) / 2;

  const rows = db.prepare(`
    SELECT *, rowid AS n, ((lat-?)*(lat-?) + (lon-?)*(lon-?)) AS d2
      FROM cameras
     WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
       AND status IN (${statuses.map(() => '?').join(',')})
     ORDER BY d2 ASC LIMIT ?`)
    .all(cy, cy, cx, cx, Math.min(s, n), Math.max(s, n), Math.min(w, e), Math.max(w, e), ...statuses, limit);

  res.json({ count: rows.length, cameras: rows.map(shape) });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ cameras: [] });
  const rows = db.prepare(`
    SELECT *, rowid AS n FROM cameras
     WHERE status IN ('online','stale') AND (name LIKE ? OR locality LIKE ? OR region LIKE ?)
     ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name LIMIT 40`)
    .all(`%${q}%`, `%${q}%`, `%${q}%`, `${q}%`);
  res.json({ cameras: rows.map(shape) });
});

// Nominatim asks for <=1 request/second and a real User-Agent; cache hard.
const geoCache = new Map();
let geoLast = 0;
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ places: [] });
  const key = q.toLowerCase();
  if (geoCache.has(key)) return res.json({ places: geoCache.get(key), cached: true });

  const wait = Math.max(0, 1100 - (Date.now() - geoLast));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  geoLast = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': config.userAgent, 'Accept-Language': 'en' },
    });
    if (!r.ok) return res.status(502).json({ places: [] });
    const data = await r.json();
    const places = data.map((p) => ({
      name: p.display_name,
      lat: parseFloat(p.lat), lon: parseFloat(p.lon),
      bbox: p.boundingbox?.map(Number), // [south, north, west, east]
      type: p.type,
    }));
    geoCache.set(key, places);
    if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
    res.json({ places });
  } catch {
    res.status(504).json({ places: [] });
  }
});

// ---------------------------------------------------------------- media
app.get('/img/:id', serveFrame);
app.get('/hls/:id', serveHls);
app.get('/clip/:id', serveClip);

// ETag revalidation rather than a long max-age: the asset set is tiny, and a
// stale cached app.js against a newer API is a worse trade than one 304.
app.use(express.static(path.join(ROOT, 'public'), { etag: true, maxAge: 0, index: 'index.html' }));

const server = app.listen(config.port, config.host, () => {
  console.log(`[globescope] listening on http://${config.host}:${config.port}`);
  const total = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`[globescope] ${total} cameras in registry`);
  if (!process.env.NO_JOBS) { startIngestLoop(); startHealthLoop(); }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`\n[globescope] ${sig}, closing`); server.close(() => process.exit(0)); });
}
