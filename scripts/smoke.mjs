/**
 * End-to-end check against a running instance:
 *   node scripts/smoke.mjs [baseUrl]
 * Exits non-zero on the first failure, so it works as a deploy gate.
 */
import http from 'node:http';

const BASE = process.argv[2] || process.env.BASE || 'http://localhost:8080';

let failed = 0;
async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  ok   ${name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name} — ${err.message}`);
  }
}
const get = async (path, type = 'json') => {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return type === 'json' ? r.json() : r;
};

console.log(`smoke test against ${BASE}`);

await check('healthz', async () => {
  const j = await get('/healthz');
  if (!j.ok) throw new Error('not ok');
  return `${j.cameras.toLocaleString()} cameras`;
});

let meta;
await check('meta', async () => {
  meta = await get('/api/meta');
  if (!meta.bySource?.length) throw new Error('no sources');
  return `${meta.bySource.length} sources, ${(meta.counts.online || 0).toLocaleString()} online`;
});

let point;
await check('points', async () => {
  const j = await get('/api/points?status=online');
  if (!j.rows?.length) throw new Error('no live points');
  point = j.rows[0];
  return `${j.rows.length.toLocaleString()} live`;
});

let cam;
await check('camera detail', async () => {
  cam = await get(`/api/camera/n/${point[0]}`);
  if (!cam.id) throw new Error('no camera returned');
  return cam.name.slice(0, 48);
});

await check('frame proxy', async () => {
  const r = await get(cam.image, 'raw');
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (!ct.startsWith('image/')) throw new Error(`content-type ${ct}`);
  if (buf.length < 1200) throw new Error(`only ${buf.length} bytes`);
  return `${ct}, ${(buf.length / 1024).toFixed(0)} KB`;
});

await check('frame cache headers', async () => {
  // The whole point of the proxy is that an edge can serve repeats. A deploy
  // that loses these headers quietly turns every viewer back into a request
  // to a public agency, so it is a gate, not a nicety.
  const r = await get(cam.image, 'raw');
  await r.arrayBuffer();
  const cc = r.headers.get('cache-control') || '';
  const etag = r.headers.get('etag');
  const ttl = +(cc.match(/s-maxage=(\d+)/)?.[1] || 0);
  if (!ttl) throw new Error(`no s-maxage in "${cc}"`);
  if (!etag) throw new Error('no ETag');
  if (!/stale-if-error=\d+/.test(cc)) throw new Error('no stale-if-error');
  if (cam.refresh_sec && ttl < Math.min(cam.refresh_sec, 300)) {
    throw new Error(`s-maxage=${ttl} below the camera's ${cam.refresh_sec}s cadence`);
  }

  // Raw http, not fetch: the Fetch spec forces `cache-control: no-cache` onto
  // any request carrying If-None-Match, which would defeat revalidation here.
  const u = new URL(BASE + cam.image);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
        headers: { 'If-None-Match': etag } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  if (status !== 304) throw new Error(`revalidation returned ${status}, not 304`);
  return `s-maxage=${ttl}s, revalidates to 304`;
});

await check('bbox query', async () => {
  const j = await get(`/api/cameras?bbox=${cam.lon - 0.5},${cam.lat - 0.5},${cam.lon + 0.5},${cam.lat + 0.5}&limit=5`);
  if (!j.count) throw new Error('empty bbox');
  return `${j.count} nearby`;
});

await check('name search', async () => {
  const j = await get(`/api/search?q=${encodeURIComponent(cam.name.split(/[\s/]/)[0] || 'I-')}`);
  return `${j.cameras.length} matches`;
});

await check('geocode', async () => {
  const j = await get('/api/geocode?q=Helsinki');
  if (!j.places?.length) throw new Error('no places');
  return j.places[0].name.slice(0, 40);
});

await check('hls proxy', async () => {
  // Only some sources publish HLS, so look in one that does rather than
  // scanning the head of the global list (which is one MP4-only source).
  const j = await get('/api/points?status=online&source=caltrans');
  for (const row of j.rows.slice(0, 60)) {
    const c = await get(`/api/camera/n/${row[0]}`);
    if (c.stream_kind !== 'hls') continue;
    const r = await get(c.stream, 'raw');
    const text = await r.text();
    if (!text.includes('#EXTM3U')) throw new Error('not a playlist');
    const proxied = text.split('\n').filter((l) => l.startsWith('/hls/') || l.startsWith('/clip/')).length;
    return `playlist ok, ${proxied} child URLs rewritten`;
  }
  return 'skipped (no HLS camera online)';
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
