import { fetchJson, pool } from '../http.js';

const DISTRICTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const url = (d) => `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, '0')}.json`;

// The image path segment is stable across feed rebuilds; the array index is not.
function stableId(district, cctv) {
  const img = cctv?.imageData?.static?.currentImageURL || '';
  const m = img.match(/\/image\/([^/]+)\//);
  if (m) return `d${district}-${m[1]}`;
  return `d${district}-${cctv.index}`;
}

export default {
  id: 'caltrans',
  label: 'Caltrans CCTV — California',
  attribution: 'California Department of Transportation',
  license: 'Public domain (US state agency)',
  home: 'https://cwwp2.dot.ca.gov',

  async fetchAll() {
    const results = await pool(DISTRICTS, 4, async (d) => {
      const json = await fetchJson(url(d), { timeout: 45000 });
      return (json.data || []).map((row) => ({ d, cctv: row.cctv })).filter((r) => r.cctv);
    });

    const out = [];
    const seen = new Set();
    for (const r of results) {
      if (!Array.isArray(r)) continue; // district feed failed; others still load
      for (const { d, cctv } of r) {
        const loc = cctv.location || {};
        const img = cctv.imageData?.static?.currentImageURL;
        const stream = cctv.imageData?.streamingVideoURL;
        if (!img && !stream) continue;

        const native = stableId(d, cctv);
        if (seen.has(native)) continue;
        seen.add(native);

        const freqMin = parseFloat(cctv.imageData?.static?.currentImageUpdateFrequency) || 1;
        out.push({
          id: `caltrans:${native}`,
          source: 'caltrans',
          native_id: native,
          name: loc.locationName || `District ${d} camera ${cctv.index}`,
          lat: parseFloat(loc.latitude),
          lon: parseFloat(loc.longitude),
          country: 'US',
          region: 'California',
          locality: loc.nearbyPlace || loc.county || null,
          kind: 'traffic',
          image_url: img || null,
          stream_url: stream || null,
          page_url: 'https://cwwp2.dot.ca.gov/vm/iframemap.htm',
          refresh_sec: Math.max(30, Math.min(300, Math.round(freqMin * 60))),
          provider_state: cctv.inService === 'false' ? 'down' : 'up',
        });
      }
    }
    return out;
  },
};
