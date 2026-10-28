import { fetchJson } from '../http.js';

const STATIONS = 'https://tie.digitraffic.fi/api/weathercam/v1/stations';
const IMAGE = (presetId) => `https://weathercam.digitraffic.fi/${presetId}.jpg`;

const prettify = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

export default {
  id: 'digitraffic-fi',
  label: 'Digitraffic weather cameras — Finland',
  attribution: 'Fintraffic / digitraffic.fi',
  license: 'CC BY 4.0',
  home: 'https://www.digitraffic.fi',

  async fetchAll() {
    const geo = await fetchJson(STATIONS, {
      timeout: 60000,
      headers: { 'Accept-Encoding': 'gzip' },
    });

    const out = [];
    for (const f of geo.features || []) {
      const p = f.properties || {};
      const [lon, lat] = f.geometry?.coordinates || [];
      const stationUp = p.collectionStatus === 'GATHERING';

      for (const preset of p.presets || []) {
        out.push({
          id: `digitraffic-fi:${preset.id}`,
          source: 'digitraffic-fi',
          native_id: preset.id,
          // Each preset is one fixed direction the camera rotates through.
          name: `${prettify(p.name)} — view ${preset.id.slice(-2)}`,
          lat,
          lon,
          country: 'FI',
          region: null,
          locality: null,
          kind: 'weather',
          image_url: IMAGE(preset.id),
          stream_url: null,
          page_url: `https://www.digitraffic.fi/en/road-traffic/#weather-camera-stations`,
          refresh_sec: 300,
          provider_state: stationUp && preset.inCollection !== false ? 'up' : 'down',
        });
      }
    }
    return out;
  },
};
