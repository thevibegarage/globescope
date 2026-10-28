import { createHash } from 'node:crypto';
import { db, logRun } from '../db.js';
import { config } from '../config.js';
import { resolveImageUrl } from '../resolvers.js';
// Importing the registry is what registers per-source URL resolvers; without it
// this job would probe expired URLs when run standalone.
import { allSources } from '../sources/index.js';

// Sources whose liveness comes from their own API rather than an image pull.
const SKIP_SOURCES = allSources.filter((s) => s.skipHealthProbe).map((s) => s.id);

// Cameras are checked by actually pulling a frame. A feed that answers but has
// served a byte-identical frame for hours is "stale" (frozen), not live.
const PER_HOST = config.healthPerHost;

// Placeholder-card detection. Frame sizes are bucketed into BUCKET_BYTES-wide
// windows; a window that many cameras of one source land in at the same moment
// is not a coincidence, it is the agency's "unavailable" graphic.
const BUCKET_BYTES = 16;
const SIG_MIN_CAMERAS = 12;   // cameras sharing one window before it counts
const SIG_MIN_SOURCE = 50;    // ignore sources too small to judge

const bucketOf = (bytes) => Math.floor(bytes / BUCKET_BYTES);

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown'; }
}

async function probe(cam) {
  const url = cam.image_url ? await resolveImageUrl(cam) : cam.stream_url;
  if (!url) return { code: 0, ok: false };
  const isPlaylist = !cam.image_url && /\.m3u8(\?|$)/i.test(cam.stream_url || '');

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(config.healthTimeoutMs),
    headers: {
      'User-Agent': config.userAgent,
      Accept: isPlaylist ? '*/*' : 'image/*,*/*',
      ...(cam.page_url ? { Referer: cam.page_url } : {}),
    },
  });

  const code = res.status;
  if (!res.ok) { await res.body?.cancel(); return { code, ok: false }; }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());

  if (isPlaylist) {
    const text = buf.toString('utf8', 0, 2048);
    const valid = text.includes('#EXTM3U');
    return { code, ok: valid, bytes: buf.length, hash: null, live: valid };
  }

  // A 0-byte body, an HTML error page, or a tiny placeholder is not a frame.
  const looksImage = ct.startsWith('image/') || buf.subarray(0, 3).toString('hex') === 'ffd8ff';
  const ok = looksImage && buf.length > 1200;
  return {
    code, ok, bytes: buf.length,
    hash: ok ? createHash('sha1').update(buf).digest('hex').slice(0, 16) : null,
  };
}

let sigs = new Set(); // "source:bucket" entries, refreshed at sweep start

function loadSigs() {
  sigs = new Set(
    db.prepare('SELECT source, bucket FROM placeholder_sigs').all()
      .map((r) => `${r.source}:${r.bucket}`)
  );
}

/** Recompute signatures from the frames just collected, then retire matches. */
function detectPlaceholders() {
  const big = db.prepare(`
    SELECT source FROM cameras WHERE bytes IS NOT NULL
     GROUP BY source HAVING COUNT(*) >= ?`).all(SIG_MIN_SOURCE).map((r) => r.source);
  if (!big.length) return 0;

  const marks = big.map(() => '?').join(',');
  db.exec('DELETE FROM placeholder_sigs');
  db.prepare(`
    INSERT INTO placeholder_sigs (source, bucket, cameras, noted_at)
    SELECT source, CAST(bytes / ? AS INTEGER), COUNT(DISTINCT id), ?
      FROM cameras
     WHERE bytes IS NOT NULL AND source IN (${marks})
     GROUP BY source, CAST(bytes / ? AS INTEGER)
    HAVING COUNT(DISTINCT id) >= ?`)
    .run(BUCKET_BYTES, Date.now(), ...big, BUCKET_BYTES, SIG_MIN_CAMERAS);

  const hit = db.prepare(`
    UPDATE cameras SET status = 'offline', provider_state = 'placeholder'
     WHERE bytes IS NOT NULL
       AND EXISTS (SELECT 1 FROM placeholder_sigs p
                    WHERE p.source = cameras.source
                      AND p.bucket = CAST(cameras.bytes / ? AS INTEGER))`)
    .run(BUCKET_BYTES).changes;

  loadSigs();
  return hit;
}

const update = db.prepare(`
  UPDATE cameras SET status=?, http_code=?, bytes=?, frame_hash=?, changed_at=?,
         checked_at=?, ok_at=?, fail_count=? WHERE id=?`);

async function checkOne(cam) {
  const now = Date.now();
  let r;
  try { r = await probe(cam); } catch (err) { r = { code: 0, ok: false, err: err.message }; }

  if (!r.ok) {
    const fails = (cam.fail_count || 0) + 1;
    const status = fails >= config.offlineAfterFails ? 'offline' : (cam.status || 'unknown');
    update.run(status, r.code || 0, r.bytes ?? null, cam.frame_hash, cam.changed_at,
               now, cam.ok_at, fails, cam.id);
    return status;
  }

  // A known placeholder card answers 200 with a perfectly valid image.
  if (r.bytes != null && sigs.has(`${cam.source}:${bucketOf(r.bytes)}`)) {
    update.run('offline', r.code, r.bytes, r.hash, cam.changed_at, now, cam.ok_at, 0, cam.id);
    db.prepare("UPDATE cameras SET provider_state='placeholder' WHERE id=?").run(cam.id);
    return 'placeholder';
  }

  // HLS playlists carry no frame to hash; treat a valid playlist as live.
  const changedAt = r.hash == null || r.hash !== cam.frame_hash ? now : cam.changed_at || now;
  const frozenFor = now - changedAt;
  const status = r.hash != null && frozenFor > config.staleAfterMin * 60000 ? 'stale' : 'online';

  update.run(status, r.code, r.bytes ?? null, r.hash ?? cam.frame_hash, changedAt,
             now, now, 0, cam.id);
  // A camera serving real frames again is no longer a placeholder. Without
  // this the label sticks for good and inflates every placeholder count.
  db.prepare("UPDATE cameras SET provider_state='up' WHERE id=? AND provider_state='placeholder'")
    .run(cam.id);
  return status;
}

/** Group by host so one agency never sees more than PER_HOST parallel requests. */
async function runGrouped(cams, globalLimit) {
  const byHost = new Map();
  for (const c of cams) {
    const h = hostOf(c.image_url || c.stream_url);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(c);
  }

  const tally = {};
  const queues = [...byHost.values()];
  let active = 0, qi = 0;

  await new Promise((resolve) => {
    const hostActive = new Map();
    const pump = () => {
      let progressed = false;
      for (let scanned = 0; scanned < queues.length && active < globalLimit; scanned++) {
        const q = queues[(qi + scanned) % queues.length];
        if (!q.length) continue;
        const h = hostOf(q[0].image_url || q[0].stream_url);
        if ((hostActive.get(h) || 0) >= PER_HOST) continue;

        const cam = q.shift();
        active++; hostActive.set(h, (hostActive.get(h) || 0) + 1);
        progressed = true;
        checkOne(cam)
          .then((s) => { tally[s] = (tally[s] || 0) + 1; })
          .catch(() => { tally.error = (tally.error || 0) + 1; })
          .finally(() => {
            active--; hostActive.set(h, hostActive.get(h) - 1);
            qi++; pump();
          });
      }
      if (!progressed && active === 0) resolve();
    };
    pump();
    if (!cams.length) resolve();
  });

  return tally;
}

export async function runHealthSweep(limit = 4000) {
  const started = Date.now();
  const skipMarks = SKIP_SOURCES.map(() => '?').join(',');
  const cams = db.prepare(`
    SELECT id, source, image_url, stream_url, page_url, frame_hash, changed_at, ok_at,
           fail_count, status
      FROM cameras
     WHERE COALESCE(provider_state,'') != 'withdrawn'
       AND (image_url IS NOT NULL OR stream_url IS NOT NULL)
       ${SKIP_SOURCES.length ? `AND source NOT IN (${skipMarks})` : ''}
     ORDER BY COALESCE(checked_at, 0) ASC
     LIMIT ?`).all(...SKIP_SOURCES, limit);

  if (!cams.length) return {};
  loadSigs();
  const tally = await runGrouped(cams, config.healthConcurrency);
  tally.placeholderRetired = detectPlaceholders();
  logRun('health', null, started, true, cams.length, JSON.stringify(tally));
  console.log(`[health] checked ${cams.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`, tally);
  return tally;
}

export function startHealthLoop() {
  let running = false;
  const tick = async () => {
    // Politeness caps probing at 4 requests per upstream host, so a sweep of a
    // source-heavy batch can outlast its interval. Never start a second one.
    if (running) { console.warn('[health] previous sweep still running, skipping tick'); return; }
    running = true;
    try {
      const batch = Math.max(500, Math.ceil(
        db.prepare('SELECT COUNT(*) c FROM cameras').get().c / 4));
      await runHealthSweep(batch);
    } catch (e) {
      console.error('[health] loop error', e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 15000);
  setInterval(tick, config.healthIntervalMin * 60000);
}

if (process.argv.includes('--once')) {
  await runHealthSweep(parseInt(process.env.LIMIT || '500', 10));
  process.exit(0);
}
