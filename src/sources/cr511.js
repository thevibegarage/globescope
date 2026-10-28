import { fetchJson, fetchText, pool } from '../http.js';

// Several North American 511 traveller-information sites run the same platform.
// Preferred path: POST /List/GetData/Cameras returns full records (names, flags,
// one entry per camera view). Some deployments have that endpoint disabled, so we
// fall back to GET /map/mapIcons/Cameras (positions only) plus per-camera tooltips.
// Either way the live JPEG is served from /map/Cctv/{imageId}.

const PAGE = 100; // the platform caps a page at 100 records regardless of `length`

function parsePoint(latLng) {
  const wkt = latLng?.geography?.wellKnownText;
  if (!wkt) return null;
  const m = wkt.match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i);
  if (!m) return null;
  return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

const stripTags = (html) =>
  html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();

async function listApi(host, ctx) {
  const rows = [];
  let start = 0;
  let total = Infinity;

  while (start < total && start < 40000) {
    // One flaky page must not drop the source to the fallback id space, so each
    // page gets its own retries and a mid-run failure aborts loudly.
    const json = await fetchJson(`https://${host}/List/GetData/Cameras`, {
      method: 'POST',
      timeout: 60000,
      retries: 3,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Referer: `https://${host}/`,
      },
      body: `draw=1&start=${start}&length=${PAGE}`,
    });
    total = json.recordsTotal ?? 0;
    const batch = json.data || [];
    if (!batch.length) break;
    rows.push(...batch);
    start += PAGE;
  }

  if (total && rows.length < total * 0.9) {
    throw new Error(`incomplete list: got ${rows.length} of ${total}`);
  }

  const out = [];
  for (const rec of rows) {
    const pt = parsePoint(rec.latLng);
    if (!pt) continue;
    const place = rec.location || rec.roadway || `Camera ${rec.id}`;

    for (const im of rec.images || []) {
      if (!im.imageUrl) continue;
      const down = Boolean(im.disabled || im.blocked) || rec.visible === false;
      const view = im.description && im.description !== place ? ` — ${im.description}` : '';
      out.push({
        ...ctx,
        id: `${ctx.source}:${im.id}`,
        native_id: String(im.id),
        name: `${place}${view}`,
        lat: pt.lat,
        lon: pt.lon,
        locality: rec.area || null,
        image_url: new URL(im.imageUrl, `https://${host}`).href,
        provider_state: down ? 'down' : 'up',
      });
    }
  }
  return out;
}

async function iconsApi(host, ctx) {
  const json = await fetchJson(`https://${host}/map/mapIcons/Cameras`, {
    timeout: 45000,
    headers: { Referer: `https://${host}/` },
  });
  const items = (json.item2 || []).filter((i) => Array.isArray(i.location));

  // Positions come free; names cost one small request each, so only enrich a
  // sane number of them and degrade to a positional label otherwise.
  let names = new Map();
  if (items.length <= 2000) {
    const got = await pool(items, 8, async (it) => {
      const html = await fetchText(
        `https://${host}/tooltip/Cameras/${it.itemId}?lang=en&noCss=true`,
        { timeout: 15000, retries: 0, headers: { Referer: `https://${host}/` } }
      );
      const td = html.match(/CameraTooltipDescriptionColumn[^>]*>([\s\S]*?)<\/td>/i);
      const text = stripTags(td ? td[1] : '');
      return text && text.length > 2 ? text.slice(0, 160) : null;
    });
    items.forEach((it, i) => {
      const v = got[i];
      if (v && typeof v === 'string') names.set(it.itemId, v);
    });
  }

  return items.map((it) => ({
    ...ctx,
    id: `${ctx.source}:${it.itemId}`,
    native_id: String(it.itemId),
    name: names.get(it.itemId) || `${ctx.region} camera ${it.itemId}`,
    lat: it.location[0],
    lon: it.location[1],
    locality: null,
    image_url: `https://${host}/map/Cctv/${it.itemId}`,
    provider_state: 'up',
  }));
}

export function makeCr511({
  id, host, label, country, region, attribution,
  license = 'Open data — see agency terms', kind = 'traffic', mode = 'auto',
}) {
  const ctx = {
    source: id, country, region, kind,
    stream_url: null,
    page_url: `https://${host}/`,
    refresh_sec: 60,
  };

  return {
    id, label, attribution, license,
    home: `https://${host}`,

    // The two endpoints key cameras differently (image id vs site id), so the
    // mode travels with the result and ingest refuses to retire across a switch.
    async fetchAll() {
      if (mode !== 'icons') {
        try {
          const rows = await listApi(host, ctx);
          if (rows.length) return { rows, mode: 'list' };
        } catch (err) {
          if (mode === 'list') throw err;
          console.warn(`[${id}] list endpoint failed (${err.message}); using icon fallback`);
        }
      }
      return { rows: await iconsApi(host, ctx), mode: 'icons' };
    },
  };
}

export const cr511Sources = [
  makeCr511({
    id: 'on511', host: '511on.ca', label: '511 Ontario',
    country: 'CA', region: 'Ontario',
    attribution: 'Ontario Ministry of Transportation',
  }),
  makeCr511({
    id: 'fl511', host: 'fl511.com', label: 'FL511 — Florida',
    country: 'US', region: 'Florida',
    attribution: 'Florida Department of Transportation',
  }),
  makeCr511({
    id: 'ga511', host: '511ga.org', label: '511 Georgia',
    country: 'US', region: 'Georgia',
    attribution: 'Georgia Department of Transportation',
  }),
  makeCr511({
    id: 'id511', host: '511.idaho.gov', label: '511 Idaho',
    country: 'US', region: 'Idaho',
    attribution: 'Idaho Transportation Department',
  }),
  makeCr511({
    id: 'ab511', host: '511.alberta.ca', label: '511 Alberta',
    country: 'CA', region: 'Alberta',
    attribution: 'Alberta Transportation',
    mode: 'icons', // this deployment has the list endpoint disabled
  }),
];
