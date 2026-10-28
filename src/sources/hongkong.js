import { fetchText } from '../http.js';

// Hong Kong Transport Department publishes a flat XML index of its traffic
// snapshot cameras; each entry points at a JPEG refreshed every two minutes.
const INDEX = 'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml';

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
};

export default {
  id: 'hk-td',
  label: 'Transport Department — Hong Kong',
  attribution: 'Transport Department, HKSAR Government',
  license: 'data.gov.hk terms of use',
  home: 'https://data.gov.hk/en/',

  async fetchAll() {
    const xml = await fetchText(INDEX, { timeout: 45000 });
    const out = [];

    for (const block of xml.match(/<image>[\s\S]*?<\/image>/gi) || []) {
      const key = tag(block, 'key');
      const url = tag(block, 'url');
      const lat = parseFloat(tag(block, 'latitude'));
      const lon = parseFloat(tag(block, 'longitude'));
      if (!key || !url || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      out.push({
        id: `hk-td:${key}`,
        source: 'hk-td',
        native_id: key,
        name: tag(block, 'description') || `Camera ${key}`,
        lat, lon,
        country: 'HK',
        region: tag(block, 'region'),
        locality: tag(block, 'district'),
        kind: 'traffic',
        image_url: url,
        stream_url: null,
        page_url: 'https://www.hkemobility.gov.hk/en/traffic-information/live/cctv',
        refresh_sec: 120,
        provider_state: 'up',
      });
    }
    return out;
  },
};
