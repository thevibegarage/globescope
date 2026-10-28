import { fetchJson } from '../http.js';

const ENDPOINT = 'https://api.tfl.gov.uk/Place/Type/JamCam';

export default {
  id: 'tfl-london',
  label: 'TfL JamCams — London',
  attribution: 'Powered by TfL Open Data',
  license: 'OGL v2.0',
  home: 'https://api.tfl.gov.uk',

  async fetchAll() {
    const places = await fetchJson(ENDPOINT, { timeout: 60000 });
    const out = [];
    for (const p of places) {
      const props = {};
      for (const a of p.additionalProperties || []) props[a.key] = a.value;
      if (!props.imageUrl) continue;
      out.push({
        id: `tfl-london:${p.id}`,
        source: 'tfl-london',
        native_id: p.id,
        name: p.commonName + (props.view ? ` (${props.view})` : ''),
        lat: p.lat,
        lon: p.lon,
        country: 'GB',
        region: 'England',
        locality: 'London',
        kind: 'traffic',
        image_url: props.imageUrl,
        // TfL publishes a short looping MP4 alongside each still.
        stream_url: props.videoUrl || null,
        page_url: 'https://tfl.gov.uk/traffic/status/',
        refresh_sec: 60,
        provider_state: props.available === 'false' ? 'down' : 'up',
      });
    }
    return out;
  },
};
