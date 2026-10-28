import { fetchJson } from '../http.js';

// NZTA's traffic service content-negotiates, and defaults to XML unless the
// request asks for JSON exactly.
const ENDPOINT = 'https://trafficnz.info/service/traffic/rest/4/cameras/all';
const ORIGIN = 'https://trafficnz.info';

export default {
  id: 'nzta',
  label: 'NZTA Waka Kotahi — New Zealand',
  attribution: 'NZ Transport Agency Waka Kotahi',
  license: 'CC BY 4.0',
  home: 'https://trafficnz.info',

  async fetchAll() {
    const json = await fetchJson(ENDPOINT, {
      timeout: 45000,
      headers: { Accept: 'application/json' },
    });

    const out = [];
    for (const c of json.response?.camera || []) {
      if (!c.imageUrl || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) continue;
      const name = [c.name?.trim(), c.description?.trim()].filter(Boolean).join(' — ');

      out.push({
        id: `nzta:${c.id}`,
        source: 'nzta',
        native_id: String(c.id),
        name: name || `Camera ${c.id}`,
        lat: c.latitude,
        lon: c.longitude,
        country: 'NZ',
        region: c.region?.name || c.highway || null,  // region is {id, name}
        locality: null,
        kind: 'traffic',
        image_url: new URL(c.imageUrl, ORIGIN).href,
        stream_url: null,
        page_url: 'https://www.journeys.nzta.govt.nz/traffic-cameras',
        refresh_sec: 120,
        provider_state: c.offline === true ? 'down' : 'up',
      });
    }
    return out;
  },
};
