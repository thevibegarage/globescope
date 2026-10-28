# OpenCam

A live, zoomable world map of cameras that are **published for public viewing** — highway CCTV, road-weather cameras and civic webcams. Zoom into a city, see which feeds are on right now, click one and watch it.

Built to run 24×7: it re-pulls every provider's camera registry on a schedule, continuously probes each feed to decide whether it is actually live, and proxies the media so mixed-content, hotlink and CORS problems never reach the browser.

## What it does and does not index

OpenCam only aggregates feeds that an agency or operator publishes openly: Caltrans district CCTV, TfL JamCams, Fintraffic road-weather cameras, state and provincial 511 systems, and (optionally) the Windy webcam network.

It deliberately does **not** index private or unsecured cameras — the "search the internet for cameras left on default credentials" approach. Those cameras were never published for public viewing, and putting them on a map is unauthorized access dressed up as a directory. Every camera here arrives with its source and licence attached, shown in the app's About panel.

## Licence

OpenCam's own code is MIT. The camera feeds it aggregates are **not** — each
remains under its provider's terms, listed per source below and in the app's
About panel. Redistributing frames at scale is the provider's call, not this
licence's.

## Quick start

```bash
npm install            # needs Node 24+ (node:sqlite is flagged on 22)
npm run ingest     # first pull: ~5 min, ~21k cameras
npm start          # http://localhost:8080
```

The server runs both background jobs itself, so `npm start` alone is enough after the first ingest — it will catch up on a stale registry at boot.

### fly.io (the deployed setup)

`fly.toml` is committed and configured for this app's shape — a persistent
volume for SQLite, and `auto_stop_machines = false` with
`min_machines_running = 1`, because the ingest and liveness jobs have to keep
running when nobody is on the site. A scale-to-zero platform would silently
break the whole premise.

```bash
fly auth login
fly launch --no-deploy --copy-config --name <your-app-name>
fly volumes create opencam_data --size 3 --region <region>
fly secrets set WINDY_API_KEY=...        # optional
fly deploy
```

First boot starts with an empty database and fills it from the sources, so the
map stays sparse for the first ten minutes or so and longer if Windy is on.

**Put a CDN in front of `/img` before sending real traffic anywhere.** Every
viewer pulls frames through the proxy to Caltrans, TfL, FL511 and the rest;
uncached, a busy day turns this into a sustained load on public agency
infrastructure. `FRAME_CACHE_SEC` only dedupes within one server process.

### Docker (recommended for 24×7)

```bash
docker compose up -d --build
```

Data lives in the `opencam-data` volume; `restart: unless-stopped` plus a container healthcheck covers crashes and reboots. For a bare-metal host, `deploy/opencam.service` (systemd) and `deploy/com.opencam.server.plist` (macOS launchd) do the same job.

## How it works

```
sources/*.js ──► ingest job ──► SQLite ──► HTTP API ──► MapLibre frontend
                   every 3h        ▲                      (clustered points)
                                   │
                 health job ───────┘        media proxy ──► /img /hls /clip
                 every 20m, pulls a frame per camera
```

**Liveness is measured, not assumed.** The health job fetches a real frame from each camera and classifies it:

| status | meaning |
| --- | --- |
| `online` | returned a valid image that has changed recently |
| `stale` | still serving, but the exact same bytes for over `STALE_AFTER_MIN` (frozen camera) |
| `offline` | failed `OFFLINE_AFTER_FAILS` probes, serves a placeholder card, or the provider withdrew it |

### Placeholder cards

The hard case is a camera that is down while its agency happily returns HTTP 200
with a valid JPEG reading **"Temporarily Unavailable"**. Caltrans and the 511
sites do this for hundreds of cameras at a time, and they stamp a *live clock*
onto the card — so the bytes change every pull and a frozen-frame check never
fires.

What does give them away is that one agency serves the same near-identical image
from dozens of cameras at once. After every sweep, OpenCam buckets frame sizes
into 16-byte windows per source; a window holding 12 or more cameras is recorded
as a placeholder signature, and every camera matching it is retired. Real scenes
never cluster that tightly — they vary by kilobytes. Signatures are recomputed
from scratch each sweep, so a camera that starts sending real frames again comes
straight back onto the map.

On the current feed set this retires **2,476 cameras — 11.7% of every agency
camera probed**, roughly one in nine — that would otherwise show as live.
The label clears automatically as soon as a camera serves a real frame again;
an earlier version let it stick, which inflated the count to 6,581.

The map shows `online` + `stale` by default and hides `offline`, which is what "cameras that are ON" means in practice — a provider's own "in service" flag is frequently wrong.

Probes are capped at `HEALTH_PER_HOST` (8) concurrent requests per upstream host
so no agency sees a burst, and each sweep walks the least-recently-checked
cameras first. Because a batch usually lands on one source, that per-host cap —
not `HEALTH_CONCURRENCY` — is what sets real throughput; lower it if a provider
objects, and raise `HEALTH_INTERVAL_MIN` to match.

## Sources

| id | coverage | cameras | notes |
| --- | --- | --- | --- |
| `fl511` | Florida | ~5,000 | |
| `ga511` | Georgia | ~4,300 | |
| `caltrans` | California | ~3,600 | still images + ~2,300 HLS streams |
| `digitraffic-fi` | Finland | ~2,300 | road-weather, CC BY 4.0 |
| `on511` | Ontario | ~1,700 | |
| `hk-td` | Hong Kong | ~1,010 | Transport Department snapshots |
| `vegvesen-no` | Norway | ~900 | OGC API Features over DATEX II; reports camera faults |
| `tfl-london` | London | ~890 | still + MP4 clip |
| `id511` | Idaho | ~730 | |
| `ab511` | Alberta | ~350 | names resolved via tooltips |
| `nzta` | New Zealand | ~310 | reports its own offline flag |
| `sg-lta` | Singapore | ~10 | LTA expressway cameras via data.gov.sg |
| `windy` | worldwide | ~69,000 catalogue | **optional**, needs a free `WINDY_API_KEY` — see below |

### Windy (the optional global source)

Windy's webcam network reaches places no agency feed covers. The key is free
from <https://api.windy.com/keys>. Three free-tier facts shape the adapter, and
all three were measured against a live key rather than assumed:

- **Image URLs expire after 10 minutes.** They are token-signed and return 401
  once stale, so the URL captured at ingest is dead long before anyone clicks
  the camera. The adapter registers a *resolver* (`src/resolvers.js`): the frame
  proxy mints a fresh URL per camera on demand and caches it for seven minutes.
  No other source needs this.
- **Listing offset is capped at 1000**, so no single query returns more than
  ~1000 webcams however big the result set. The catalogue holds **69,210**, so
  the sweep shards by country (201 of them, from the API's own `/countries`),
  and any country over the cap is split again by its regions (2,322 available
  via `/regions`). Nine countries need that second split — Italy alone has
  3,198 webcams, Austria 3,095, Germany 2,779.
- **There is a rate limit the docs do not mention: 300 requests per rolling
  window**, reported live in `x-ratelimit-limit` / `-remaining` / `-reset`. A
  first sweep at three workers blew straight through it and lost whole
  countries to HTTP 429. The adapter now serialises every call through one gate
  that paces itself from those headers and sits out the window when the budget
  runs low; `src/http.js` also honours `Retry-After` on 429 for all sources.
- **Liveness is not probed.** Windy reports each webcam's `status` itself, so
  these cameras are exempt from the image-pulling health sweep
  (`skipHealthProbe`). Probing them would add tens of thousands of URL-minting
  calls and image fetches per sweep against a free key, for information the
  provider already hands over at ingest.

The free tier also expects images to link or embed back to windy.com, which the
camera panel's "Provider site" link satisfies.

Setup:

```bash
echo "WINDY_API_KEY=your-key-here" >> .env
npm run windy:check     # validates the key and every assumption above
npm run ingest          # pulls the webcams in
```

`.env` is read automatically at startup and is gitignored. Real environment
variables still win over the file, so a service unit can override it.
`WINDY_COUNTRIES=IN,JP,DE` restricts the sweep to named countries.

### Coverage gaps

Asia and Europe are thinner than North America because far fewer agencies
publish open camera feeds there, not because they were skipped:

- **India has essentially no open live camera data.** There is no official
  government API: city traffic police and Smart City portals publish viewer
  pages, not machine-readable feeds, and the only Indian datasets available are
  static camera *locations* (e.g. the Bengaluru OpenCity set) rather than
  images. Windy does not fill the gap either — it lists just **10** webcams for
  the whole of India (Chennai, Hyderabad, Tiruvannamalai, Bir and a handful
  more). Indian coverage is the one request this project cannot currently
  satisfy from open sources.
- **Taiwan and South Korea** both run good national CCTV APIs, but their
  endpoints did not respond from this machine; add them if they resolve for you.
- **Sweden, Denmark, Switzerland and Austria** publish camera data only behind a
  free registration key, so they fit the `windy` pattern (an env var) rather
  than the keyless default set.
- Several other European agencies (Netherlands, Spain, Ireland, Iceland,
  Estonia) now serve their camera maps from single-page apps with no documented
  public endpoint.

Turn any of them off with `DISABLED_SOURCES=ga511,fl511`.

### Adding a source

Drop a module in `src/sources/` that exports `{ id, label, attribution, license, fetchAll() }`, where `fetchAll` returns objects with at least `id, source, native_id, name, lat, lon, image_url | stream_url`. Register it in `src/sources/index.js`. The ingest, liveness, proxy and map layers then work with no further changes.

For the many North American 511 sites running the same platform, `makeCr511({ id, host, label, country, region, attribution })` is usually all that is needed.

## API

| route | purpose |
| --- | --- |
| `GET /api/points?status=online,stale` | whole live set, compact + gzipped, for the map |
| `GET /api/cameras?bbox=w,s,e,n&limit=` | cameras in a box, nearest centre first |
| `GET /api/camera/n/:rowid`, `/api/camera/:id` | one camera |
| `GET /api/search?q=` | camera name / place search |
| `GET /api/geocode?q=` | cached Nominatim passthrough for city search |
| `GET /api/meta` | per-source counts, statuses, last job runs |
| `GET /img/:id` | one proxied, cached JPEG frame |
| `GET /hls/:id` | HLS playlist with segment URLs rewritten through the proxy |
| `GET /clip/:id` | MP4 / segment passthrough with byte ranges |
| `GET /healthz` | liveness for your orchestrator |

## What has been verified

Checked against the live feeds on this machine:

- all 13 sources ingest (73,994 cameras across 125 countries), and re-ingesting is idempotent — no duplicates, nothing wrongly retired;
- the four newest sources (Norway, Hong Kong, New Zealand, Singapore) each return real frames, and placeholder detection generalised to them unprompted — it found NZTA's and Norway's "camera unavailable" cards without being told they existed;
- the liveness sweep classifies correctly, including placeholder-card retirement;
- the frame proxy, the HLS chain (master playlist → chunklist → MPEG-TS segment) and MP4 clips all serve through to a playing `<video>`;
- map, clustering, city/camera search, detail panel and live wall all work in the browser;
- the server restarts against an existing database and resumes its jobs;
- `npm run smoke` passes all nine checks;
- the launchd plist passes `plutil -lint`.

Not verified here: the Docker image build — this machine has no Docker daemon. The Dockerfile and compose file are written but untested, so build them once before relying on that path.

## Operating notes

- **Country codes are normalised.** Windy reports a country *name* where every
  agency feed reports an ISO code, so the adapter stores the code of the shard
  it queried. Mixing the two silently breaks every per-country query.
- **Bad feeds cannot empty the map**: a source that returns a truncated list is
  rejected rather than treated as mass withdrawal, a run that would retire more
  than 40% of a source is refused outright, and a source that falls back to a
  secondary endpoint (which keys cameras differently) never retires records made
  by the primary one. Each of these is a failure mode that bit this project
  during development.
- **Disk**: the SQLite file stays around 35 MB for ~74k cameras. No frames are archived — only the current frame is cached, in memory, for `FRAME_CACHE_SEC`.
- **Bandwidth**: a liveness sweep of the 21k agency cameras pulls roughly 1–2 GB (Windy's 53k are exempt). Lower it with a longer `HEALTH_INTERVAL_MIN`.
- **Basemap**: the default style is CARTO's free dark-matter, which is fine at modest traffic. Swap the `style` URL in `public/app.js` for a keyed provider or self-hosted tiles before any serious load.
- **Nominatim**: geocoding is rate-limited to 1 req/s and cached, per OSM's usage policy. Use your own geocoder if you expect real traffic.
- **Be a good citizen**: these are public-sector feeds. Keep the intervals generous, keep the `USER_AGENT` honest and identifiable, and honour each provider's terms — they are listed per source in the About panel.
