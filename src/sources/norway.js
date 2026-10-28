import { fetchJson } from '../http.js';

// Statens vegvesen publishes its DATEX II CCTV table through an OGC API
// Features view, which needs no account (the raw DATEX node does).
const BASE = 'https://ogckart-sn1.atlas.vegvesen.no/ogc/features/v1/collections/datex_3_1:CctvSimple/items';
// This server ignores `offset` and honours the OGC `startIndex` parameter;
// using the wrong one silently re-serves page one.
const PAGE = 1000;

export default {
  id: 'vegvesen-no',
  label: 'Statens vegvesen — Norway',
  attribution: 'Norwegian Public Roads Administration (Statens vegvesen)',
  license: 'NLOD',
  home: 'https://dataut.vegvesen.no/en/dataset/webkamera',

  async fetchAll() {
    const out = [];
    let startIndex = 0;
    let matched = Infinity;

    while (startIndex < matched && startIndex < 10000) {
      const json = await fetchJson(`${BASE}?limit=${PAGE}&startIndex=${startIndex}&f=json`, { timeout: 45000 });
      matched = json.numberMatched ?? 0;
      const feats = json.features || [];
      if (!feats.length) break;

      for (const f of feats) {
        const p = f.properties || {};
        const [lon, lat] = f.geometry?.coordinates || [];
        if (!p.stillImageUrl || !p.cameraId) continue;

        // The feed states the camera's own fault status, so trust it as a hint.
        const avail = p['status.stillImageAvailability'] || '';
        const down = avail && avail !== 'videoOrImagesAvailable';

        const place = [p.description, p.orientationDescription]
          .filter((v) => v && String(v).trim()).join(' — ');

        out.push({
          id: `vegvesen-no:${p.cameraId}`,
          source: 'vegvesen-no',
          native_id: p.cameraId,
          name: place || `Camera ${p.cameraId}`,
          lat, lon,
          country: 'NO',
          region: p.roadNumber || null,
          locality: null,
          kind: 'traffic',
          image_url: p.stillImageUrl,
          stream_url: null,
          page_url: 'https://www.vegvesen.no/trafikk/',
          refresh_sec: 180,
          provider_state: down ? 'down' : 'up',
        });
      }
      startIndex += feats.length;
    }
    return out;
  },
};
