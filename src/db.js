import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS cameras (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  native_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  lat            REAL NOT NULL,
  lon            REAL NOT NULL,
  country        TEXT,
  region         TEXT,
  locality       TEXT,
  kind           TEXT,
  image_url      TEXT,
  stream_url     TEXT,
  page_url       TEXT,
  refresh_sec    INTEGER DEFAULT 30,
  provider_state TEXT,
  status         TEXT NOT NULL DEFAULT 'unknown',
  http_code      INTEGER,
  bytes          INTEGER,
  frame_hash     TEXT,
  changed_at     INTEGER,
  checked_at     INTEGER,
  ok_at          INTEGER,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  attribution    TEXT,
  license        TEXT,
  first_seen     INTEGER,
  last_seen      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cam_lat     ON cameras(lat);
CREATE INDEX IF NOT EXISTS idx_cam_status  ON cameras(status);
CREATE INDEX IF NOT EXISTS idx_cam_source  ON cameras(source);
CREATE INDEX IF NOT EXISTS idx_cam_checked ON cameras(checked_at);

-- Learned signatures of "camera unavailable" placeholder cards. Agencies serve
-- these as a normal 200 JPEG, and many stamp a live clock onto them, so neither
-- the HTTP status nor a frame hash can tell them apart from a working camera.
-- What gives them away is that one source serves the same near-identical image
-- from dozens of cameras at once. Recomputed from scratch on every sweep.
CREATE TABLE IF NOT EXISTS placeholder_sigs (
  source   TEXT NOT NULL,
  bucket   INTEGER NOT NULL,
  cameras  INTEGER NOT NULL,
  noted_at INTEGER,
  PRIMARY KEY (source, bucket)
);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job        TEXT NOT NULL,
  source     TEXT,
  started_at INTEGER,
  ended_at   INTEGER,
  ok         INTEGER,
  found      INTEGER,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job, started_at);
`);

const upsertStmt = db.prepare(`
INSERT INTO cameras (
  id, source, native_id, name, lat, lon, country, region, locality, kind,
  image_url, stream_url, page_url, refresh_sec, provider_state,
  attribution, license, first_seen, last_seen
) VALUES (
  :id, :source, :native_id, :name, :lat, :lon, :country, :region, :locality, :kind,
  :image_url, :stream_url, :page_url, :refresh_sec, :provider_state,
  :attribution, :license, :now, :now
)
ON CONFLICT(id) DO UPDATE SET
  name           = excluded.name,
  lat            = excluded.lat,
  lon            = excluded.lon,
  country        = excluded.country,
  region         = excluded.region,
  locality       = excluded.locality,
  kind           = excluded.kind,
  image_url      = excluded.image_url,
  stream_url     = excluded.stream_url,
  page_url       = excluded.page_url,
  refresh_sec    = excluded.refresh_sec,
  provider_state = excluded.provider_state,
  attribution    = excluded.attribution,
  license        = excluded.license,
  last_seen      = excluded.last_seen
`);

/** Insert or refresh a batch of normalized cameras from one source. */
/** SQLite only binds primitives; a source that hands back a nested object for
 *  a text column would otherwise abort the whole batch. */
const txt = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return v.name ? String(v.name) : null;
  return String(v);
};

export function upsertCameras(rows) {
  const now = Date.now();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      if (r.lat === 0 && r.lon === 0) continue;
      if (Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) continue;
      if (!r.image_url && !r.stream_url) continue;
      upsertStmt.run({
        id: r.id,
        source: r.source,
        native_id: String(r.native_id),
        name: txt(r.name) || r.id,
        lat: r.lat,
        lon: r.lon,
        country: txt(r.country),
        region: txt(r.region),
        locality: txt(r.locality),
        kind: txt(r.kind) || 'traffic',
        image_url: txt(r.image_url),
        stream_url: txt(r.stream_url),
        page_url: txt(r.page_url),
        refresh_sec: r.refresh_sec || 30,
        provider_state: txt(r.provider_state),
        attribution: txt(r.attribution),
        license: txt(r.license),
        now,
      });
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

/**
 * Cameras the provider has stopped publishing are retired, not deleted.
 * A run that would retire most of a source is treated as a bad feed rather than
 * a real withdrawal, and is refused — one truncated response should never empty
 * a region off the map.
 */
export function retireMissing(source, cutoff, maxShare = 0.4) {
  const total = db.prepare('SELECT COUNT(*) c FROM cameras WHERE source = ?').get(source).c;
  const doomed = db.prepare(
    'SELECT COUNT(*) c FROM cameras WHERE source = ? AND last_seen < ?'
  ).get(source, cutoff).c;

  if (!doomed) return 0;
  if (total && doomed / total > maxShare) {
    return { refused: true, doomed, total };
  }
  return db.prepare(
    `UPDATE cameras SET status='offline', provider_state='withdrawn'
      WHERE source = ? AND last_seen < ?`
  ).run(source, cutoff).changes;
}

export function logRun(job, source, started, ok, found, note) {
  db.prepare(
    `INSERT INTO runs (job, source, started_at, ended_at, ok, found, note)
     VALUES (?,?,?,?,?,?,?)`
  ).run(job, source ?? null, started, Date.now(), ok ? 1 : 0, found ?? 0, note ?? null);
}
