import { activeSources } from '../sources/index.js';
import { upsertCameras, retireMissing, logRun, db } from '../db.js';
import { config } from '../config.js';

/** The id scheme a source used last time it succeeded, if it reported one. */
function lastMode(sourceId) {
  const row = db.prepare(
    `SELECT note FROM runs WHERE job='ingest' AND source=? AND ok=1
      ORDER BY started_at DESC LIMIT 1`).get(sourceId);
  return row?.note?.match(/mode=(\w+)/)?.[1] || null;
}

export async function ingestSource(src) {
  const started = Date.now();
  try {
    const result = await src.fetchAll();
    const rows = Array.isArray(result) ? result : result.rows;
    const mode = Array.isArray(result) ? 'default' : result.mode;

    const tagged = rows.map((r) => ({
      ...r,
      attribution: r.attribution || src.attribution,
      license: r.license || src.license,
    }));
    const n = upsertCameras(tagged);

    // Sources excluded from image probing get their status straight from the
    // provider's own availability field, set here at ingest time.
    if (src.skipHealthProbe && n > 0) {
      db.prepare(`
        UPDATE cameras
           SET status = CASE WHEN provider_state = 'up' THEN 'online' ELSE 'offline' END,
               checked_at = ?, ok_at = CASE WHEN provider_state = 'up' THEN ? ELSE ok_at END
         WHERE source = ?`).run(Date.now(), Date.now(), src.id);
    }

    // A source that fell back to a different endpoint keys its cameras
    // differently, so everything from the previous scheme would look withdrawn.
    const prev = lastMode(src.id);
    const sameScheme = !prev || prev === mode;

    let retired = 0;
    const notes = [`mode=${mode}`];
    if (n > 0 && sameScheme) {
      const r = retireMissing(src.id, started);
      if (typeof r === 'object' && r.refused) {
        notes.push(`retirement refused (${r.doomed}/${r.total} would go)`);
        console.warn(`[ingest] ${src.id}: refused to retire ${r.doomed} of ${r.total} cameras`);
      } else {
        retired = r;
        if (retired) notes.push(`retired ${retired}`);
      }
    } else if (!sameScheme) {
      notes.push(`scheme changed ${prev}->${mode}, retirement skipped`);
    }

    logRun('ingest', src.id, started, true, n, notes.join('; '));
    return { source: src.id, ok: true, count: n, retired, mode };
  } catch (err) {
    logRun('ingest', src.id, started, false, 0, err.message);
    return { source: src.id, ok: false, error: err.message };
  }
}

export async function runIngest() {
  const started = Date.now();
  const results = [];
  for (const src of activeSources()) {
    const r = await ingestSource(src);
    results.push(r);
    console.log(
      `[ingest] ${r.source.padEnd(15)} ${r.ok ? `${r.count} cameras` : `FAILED: ${r.error}`}`
    );
  }
  const total = db.prepare('SELECT COUNT(*) c FROM cameras').get().c;
  console.log(`[ingest] done in ${((Date.now() - started) / 1000).toFixed(1)}s — ${total} cameras known`);
  return results;
}

export function startIngestLoop() {
  let running = false;
  const tick = async () => {
    if (running) { console.warn('[ingest] previous run still going, skipping tick'); return; }
    running = true;
    try { await runIngest(); } catch (e) { console.error('[ingest] loop error', e); }
    finally { running = false; }
  };
  const last = db.prepare(
    `SELECT MAX(started_at) t FROM runs WHERE job='ingest' AND ok=1`
  ).get().t;
  const period = config.ingestIntervalMin * 60000;
  const age = last ? Date.now() - last : Infinity;

  // Catch up right after a restart only if the registry is actually stale;
  // otherwise wait out the remainder of the current interval.
  setTimeout(tick, age > period ? 2000 : period - age);
  setInterval(tick, period);
}

if (process.argv.includes('--once')) {
  await runIngest();
  process.exit(0);
}
