import { fetchJson } from '../http.js';

// data.gov.sg republishes LTA's expressway cameras. The payload carries one
// snapshot batch; the image URL changes each cycle, so the camera id is the
// stable key and the URL is refreshed on every ingest.
const ENDPOINT = 'https://api.data.gov.sg/v1/transport/traffic-images';

export default {
  id: 'sg-lta',
  label: 'LTA traffic cameras — Singapore',
  attribution: 'Land Transport Authority / data.gov.sg',
  license: 'Singapore Open Data Licence',
  home: 'https://data.gov.sg/datasets',

  async fetchAll() {
    const json = await fetchJson(ENDPOINT, { timeout: 30000 });
    const batch = json.items?.[0]?.cameras || [];

    return batch
      .filter((c) => c.image && c.location)
      .map((c) => ({
        id: `sg-lta:${c.camera_id}`,
        source: 'sg-lta',
        native_id: String(c.camera_id),
        name: `Camera ${c.camera_id}`,
        lat: c.location.latitude,
        lon: c.location.longitude,
        country: 'SG',
        region: null,
        locality: 'Singapore',
        kind: 'traffic',
        image_url: c.image,
        stream_url: null,
        page_url: 'https://onemotoring.lta.gov.sg/content/onemotoring/home/driving/traffic_information/traffic-cameras.html',
        refresh_sec: 60,
        provider_state: 'up',
      }));
  },
};
