/* Globescope — live public camera map */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const STATUS_COLOR = { online: '#34d399', stale: '#fbbf24', offline: '#64748b', unknown: '#64748b' };

const state = {
  points: { type: 'FeatureCollection', features: [] },
  status: new Set(['online', 'stale']),
  kinds: new Set(),      // empty = all
  sources: new Set(),    // empty = all
  meta: null,
  current: null,
  timer: null,
  wallTimers: [],
};

// ------------------------------------------------------------------ map
const GLOBE_ZOOM = 1.45;
const SPIN_DEG_PER_TICK = 3.2; // one tick per second while idle

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [20, 20],
  zoom: GLOBE_ZOOM,
  attributionControl: false,
  maxZoom: 19,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'bottom-right');

// Globe projection plus an atmosphere, so the planet reads as a sphere in
// space rather than a flat map. MapLibre eases back to mercator as you zoom in.
map.on('style.load', () => {
  map.setProjection({ type: 'globe' });
  map.setSky({
    'sky-color': '#05070c',
    'sky-horizon-blend': 0.55,
    'horizon-color': '#1d3b5c',
    'horizon-fog-blend': 0.7,
    'fog-color': '#0a1626',
    'fog-ground-blend': 0.35,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.35, 9, 0],
  });
});

map.on('load', async () => {
  map.addSource('cams', {
    type: 'geojson',
    data: state.points,
    cluster: true,
    clusterRadius: 60,
    clusterMaxZoom: 12,
  });

  map.addLayer({
    id: 'clusters', type: 'circle', source: 'cams', filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['step', ['get', 'point_count'], '#0f766e', 25, '#0d9488', 150, '#14b8a6', 800, '#5eead4'],
      // Cluster bubbles must stay small at globe distance or they cover the
      // planet; they grow back to readable sizes as you come in.
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        0.5, ['step', ['get', 'point_count'], 5, 100, 7, 1000, 10, 10000, 13],
        3,   ['step', ['get', 'point_count'], 8, 100, 12, 1000, 16, 10000, 20],
        6,   ['step', ['get', 'point_count'], 15, 25, 20, 150, 26, 800, 34],
      ],
      'circle-opacity': 0,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(7,10,14,.85)',
      'circle-stroke-opacity': 0,
    },
  });
  map.addLayer({
    id: 'cluster-count', type: 'symbol', source: 'cams', filter: ['has', 'point_count'],
    // Must be a stack the basemap's glyph server actually serves.
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 0.5, 0, 2, 9, 5, 12],
      'text-font': ['Montserrat SemiBold', 'Open Sans Bold', 'Noto Sans Regular'],
      'text-allow-overlap': false,
    },
    paint: { 'text-color': '#04120f', 'text-opacity': 0 },
  });
  map.addLayer({
    id: 'cam', type: 'circle', source: 'cams', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['match', ['get', 's'], 'online', STATUS_COLOR.online,
                       'stale', STATUS_COLOR.stale, STATUS_COLOR.offline],
      'circle-radius': 0, // grown to CAM_RADIUS by revealCameras()
      'circle-opacity': 0,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(7,10,14,.9)',
      'circle-stroke-opacity': 0,
    },
  });

  map.on('click', 'clusters', async (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
    const zoom = await map.getSource('cams').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom + 0.4, 17) });
  });
  map.on('click', 'cam', (e) => openCamera(e.features[0].properties.n));
  for (const l of ['clusters', 'cam']) {
    map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
  }

  await runIntro();
  setInterval(loadPoints, 120000); // statuses move as the health sweep runs
});

const CAM_RADIUS = ['interpolate', ['linear'], ['zoom'], 0, 1.6, 4, 2.2, 8, 3.5, 12, 6, 16, 9];

// ------------------------------------------------------------------ globe
let spinning = false;
let spinHeld = 0; // user interaction suspends the spin until they stop

function spinTick() {
  if (!spinning || Date.now() < spinHeld) return;
  if (map.getZoom() > 3.2) return;          // only idle at globe distance
  const c = map.getCenter();
  c.lng -= SPIN_DEG_PER_TICK;
  // linear easing + chained moveend gives one continuous rotation
  map.easeTo({ center: c, duration: 1000, easing: (t) => t });
}

function startSpin() { if (!spinning) { spinning = true; spinTick(); } }
function stopSpin(holdMs = 0) {
  spinning = false;
  if (holdMs) spinHeld = Date.now() + holdMs;
  map.stop();
}

map.on('moveend', spinTick);
for (const ev of ['mousedown', 'touchstart', 'wheel', 'dragstart']) {
  map.on(ev, () => stopSpin());
}

/** Bring the cameras up: dots fade and grow in, clusters a beat later. */
function revealCameras() {
  map.setPaintProperty('cam', 'circle-opacity-transition', { duration: 1100 });
  map.setPaintProperty('cam', 'circle-stroke-opacity-transition', { duration: 1100, delay: 150 });
  map.setPaintProperty('cam', 'circle-radius-transition', { duration: 1300 });
  map.setPaintProperty('clusters', 'circle-opacity-transition', { duration: 900, delay: 350 });
  map.setPaintProperty('cluster-count', 'text-opacity-transition', { duration: 700, delay: 650 });

  requestAnimationFrame(() => {
    map.setPaintProperty('cam', 'circle-radius', CAM_RADIUS);
    map.setPaintProperty('cam', 'circle-opacity', 0.95);
    map.setPaintProperty('cam', 'circle-stroke-opacity', 1);
    map.setPaintProperty('clusters', 'circle-opacity', 0.85);
    map.setPaintProperty('cluster-count', 'text-opacity', 1);
  });
}

function countUp(el, to, ms = 1300) {
  return new Promise((done) => {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3))).toLocaleString();
      if (t < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
}

async function runIntro() {
  const intro = $('intro');
  const bar = $('introBarFill');
  const skip = () => { if (intro && !intro.classList.contains('gone')) intro.classList.add('gone'); };
  // Never let a slow feed trap someone behind the curtain.
  const failsafe = setTimeout(skip, 20000);
  intro?.addEventListener('click', skip);

  if (bar) bar.style.width = '12%';
  await loadMeta();
  if (bar) bar.style.width = '45%';

  // Finish the count first: handing 68k points to the clusterer blocks the
  // main thread for a beat, which would otherwise freeze the counter mid-roll.
  await countUp($('introNum'), state.meta?.counts?.online || 0);
  if (bar) bar.style.width = '72%';

  await loadPoints();
  if (bar) bar.style.width = '100%';

  startSpin();
  await new Promise((r) => setTimeout(r, 500));
  clearTimeout(failsafe);
  skip();
  revealCameras();
}

/** Pull back out to the whole planet and start it turning again. */
function enterGlobe() {
  closeDetail();
  closeWall();
  $('filters').hidden = true;
  $('filterBtn').classList.remove('on');
  spinHeld = 0;
  map.flyTo({ center: [map.getCenter().lng, 15], zoom: GLOBE_ZOOM, pitch: 0, bearing: 0, duration: 2200, essential: true });
  map.once('moveend', startSpin);
}

// ------------------------------------------------------------------ data
async function loadMeta() {
  state.meta = await (await fetch('/api/meta')).json();
  const c = state.meta.counts || {};
  $('cOnline').textContent = c.online ? `(${c.online.toLocaleString()})` : '';
  $('cStale').textContent = c.stale ? `(${c.stale.toLocaleString()})` : '';
  $('cOffline').textContent = c.offline ? `(${c.offline.toLocaleString()})` : '';

  renderChips('sources', state.meta.bySource.map((s) => ({
    key: s.source,
    label: `${state.meta.labels[s.source]?.label || s.source} (${s.total})`,
  })), state.sources);

  const list = $('srcList');
  list.innerHTML = '';
  for (const s of state.meta.bySource) {
    const info = state.meta.labels[s.source] || {};
    const li = document.createElement('li');
    li.innerHTML = `<strong>${esc(info.label || s.source)}</strong> — ${s.total.toLocaleString()} cameras · ` +
      `${esc(info.attribution || '')} <span class="muted">(${esc(info.license || 'see provider')})</span>`;
    list.appendChild(li);
  }
  const h = state.meta.lastHealth;
  const ph = state.meta.placeholders
    ? ` ${state.meta.placeholders.toLocaleString()} cameras are currently serving an "unavailable" card and are hidden.`
    : '';
  $('runInfo').textContent = (h
    ? `Last liveness sweep: ${new Date(h.started_at).toLocaleString()} — ${h.found.toLocaleString()} cameras checked.`
    : 'First liveness sweep still running.') + ph;
}

async function loadPoints() {
  const qs = new URLSearchParams();
  qs.set('status', [...state.status].join(',') || 'online');
  if (state.sources.size) qs.set('source', [...state.sources].join(','));
  if (state.kinds.size) qs.set('kind', [...state.kinds].join(','));

  const data = await (await fetch(`/api/points?${qs}`)).json();
  // kinds/statuses are dictionaries; rows carry indices into them.
  const feats = new Array(data.rows.length);
  for (let i = 0; i < data.rows.length; i++) {
    const [n, lat, lon, ki, si] = data.rows[i];
    feats[i] = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { n, s: data.statuses[si], k: data.kinds[ki] },
    };
  }
  state.points = { type: 'FeatureCollection', features: feats };
  map.getSource('cams')?.setData(state.points);

  const onlineIdx = data.statuses.indexOf('online');
  const live = data.rows.filter((r) => r[4] === onlineIdx).length;
  $('liveCount').textContent = `${live.toLocaleString()} live · ${data.rows.length.toLocaleString()} shown`;

  if (!state.kinds.size && !$('kinds').childElementCount) {
    renderChips('kinds', [...data.kinds].sort().map((k) => ({ key: k, label: k })), state.kinds);
  }
}

// ------------------------------------------------------------------ detail
async function openCamera(n) {
  const cam = await (await fetch(`/api/camera/n/${n}`)).json();
  if (cam.error) return;
  showCamera(cam, true);
}

function showCamera(cam, recenter) {
  state.current = cam;
  $('detail').hidden = false;
  $('filters').hidden = true;
  $('filterBtn').classList.remove('on');

  $('dName').textContent = cam.name;
  $('dPlace').textContent = [cam.locality, cam.region, cam.country].filter(Boolean).join(', ');
  $('dSrc').href = cam.page_url || '#';
  $('dAttr').textContent = `${cam.attribution || ''}${cam.license ? ' \u00b7 ' + cam.license : ''}`;

  const badge = $('dBadge');
  badge.className = 'badge ' + cam.status;
  badge.textContent = cam.status === 'online' ? '\u25cf live'
    : cam.status === 'stale' ? '\u25cf frame not changing' : '\u25cf offline';

  $('dMeta').innerHTML = [
    ['Source', state.meta?.labels?.[cam.source]?.label || cam.source],
    ['Type', cam.kind],
    ['Refresh', `~${cam.refresh_sec}s`],
    ['Last good frame', cam.ok_at ? rel(cam.ok_at) : '\u2014'],
    ['Coordinates', `${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('');

  stopStream();
  $('dVid').hidden = true;
  $('dImg').hidden = false;
  $('dStream').hidden = !cam.has_stream;
  $('dStream').onclick = () => playStream(cam);
  startFrames(cam);

  if (recenter) {
    stopSpin();
    map.easeTo({ center: [cam.lon, cam.lat], zoom: Math.max(map.getZoom(), 13), duration: 1400 });
  }
}

function startFrames(cam) {
  clearInterval(state.timer);
  const img = $('dImg');
  const spin = $('dSpin');
  if (!cam.has_image) { spin.textContent = 'video stream only — press play'; return; }

  // Drop the previous camera's frame first, or it sits under the new title
  // until the new one arrives.
  img.removeAttribute('src');
  spin.style.display = '';
  spin.textContent = 'connecting…';
  const tick = () => {
    if (document.hidden || $('detail').hidden) return;
    img.src = frameUrl(cam);
  };
  img.onload = () => { spin.style.display = 'none'; };
  img.onerror = () => { spin.style.display = ''; spin.textContent = 'feed unavailable right now'; };
  tick();
  state.timer = setInterval(tick, Math.max(5, Math.min(cam.refresh_sec, 60)) * 1000);
}

// One frame URL per camera per refresh window, derived from absolute time so
// every viewer on earth asks for the same one. A per-request timestamp would
// make each poll a unique object, giving an edge cache nothing to hit and
// turning every viewer into another request to the agency behind the camera.
// Re-assigning an unchanged src is a no-op, so polling costs nothing until
// the window rolls over.
function frameUrl(cam) {
  const windowSec = Math.min(Math.max(cam.refresh_sec || 60, 15), 300);
  return `${cam.image}?t=${Math.floor(Date.now() / (windowSec * 1000))}`;
}

let hls = null;
function stopStream() {
  const vid = $('dVid');
  if (hls) { hls.destroy(); hls = null; }
  vid.pause(); vid.removeAttribute('src'); vid.load();
}

function playStream(cam) {
  const vid = $('dVid'), img = $('dImg');
  clearInterval(state.timer);
  img.hidden = true; vid.hidden = false;
  $('dSpin').style.display = 'none';

  if (cam.stream_kind === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true });
      hls.loadSource(cam.stream); hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED, () => vid.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) { $('dSpin').style.display = ''; $('dSpin').textContent = 'stream unavailable'; }
      });
    } else {
      vid.src = cam.stream; vid.play().catch(() => {});
    }
  } else {
    vid.src = cam.stream; vid.loop = true; vid.play().catch(() => {});
  }
}

function closeDetail() {
  $('detail').hidden = true;
  clearInterval(state.timer);
  stopStream();
}

// ------------------------------------------------------------------ wall
async function openWall() {
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(',');
  const qs = new URLSearchParams({ bbox, limit: '28', status: [...state.status].join(',') });
  const data = await (await fetch(`/api/cameras?${qs}`)).json();

  $('wall').hidden = false;
  $('wallInfo').textContent = `${data.count} cameras in view`;
  const grid = $('wallGrid');
  grid.innerHTML = '';
  clearWallTimers();

  data.cameras.filter((c) => c.has_image).forEach((cam, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<img alt="" loading="lazy"><span>${esc(cam.name)}</span>`;
    const img = cell.querySelector('img');
    const tick = () => { if (!document.hidden && !$('wall').hidden) img.src = frameUrl(cam); };
    // Stagger so 28 upstream fetches do not leave at the same instant.
    setTimeout(tick, i * 180);
    state.wallTimers.push(setInterval(tick, 20000));
    cell.onclick = () => { closeWall(); showCamera(cam, true); };
    grid.appendChild(cell);
  });
}
const clearWallTimers = () => { state.wallTimers.forEach(clearInterval); state.wallTimers = []; };
function closeWall() { $('wall').hidden = true; clearWallTimers(); }

// ------------------------------------------------------------------ search
let searchSeq = 0;
$('search').addEventListener('input', debounce(async (e) => {
  const q = e.target.value.trim();
  const box = $('results');
  if (q.length < 2) { box.hidden = true; return; }
  const seq = ++searchSeq;

  const [cams, places] = await Promise.all([
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ cameras: [] })),
    fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ places: [] })),
  ]);
  if (seq !== searchSeq) return;

  box.innerHTML = '';
  for (const p of (places.places || []).slice(0, 4)) {
    box.appendChild(row('place', p.name, () => {
      stopSpin();
      if (p.bbox) map.fitBounds([[p.bbox[2], p.bbox[0]], [p.bbox[3], p.bbox[1]]], { padding: 60, maxZoom: 15, duration: 2000 });
      else map.flyTo({ center: [p.lon, p.lat], zoom: 12, duration: 2000 });
      box.hidden = true;
    }));
  }
  for (const c of (cams.cameras || []).slice(0, 8)) {
    box.appendChild(row(c.source, c.name, () => {
      stopSpin();
      map.flyTo({ center: [c.lon, c.lat], zoom: 15, duration: 2000 });
      showCamera(c, false);
      box.hidden = true;
    }));
  }
  box.hidden = !box.childElementCount;
}, 320));

function row(kind, label, onClick) {
  const d = document.createElement('div');
  d.innerHTML = `<span class="kind">${esc(kind)}</span> ${esc(label)}`;
  d.onclick = onClick;
  return d;
}

// ------------------------------------------------------------------ chrome
function renderChips(containerId, items, set) {
  const el = $(containerId);
  el.innerHTML = '';
  for (const it of items) {
    const c = document.createElement('span');
    c.className = 'chip' + (set.has(it.key) ? ' on' : '');
    c.textContent = it.label;
    c.onclick = () => {
      set.has(it.key) ? set.delete(it.key) : set.add(it.key);
      c.classList.toggle('on');
      loadPoints();
    };
    el.appendChild(c);
  }
}

for (const [id, key] of [['fOnline', 'online'], ['fStale', 'stale'], ['fOffline', 'offline']]) {
  $(id).addEventListener('change', (e) => {
    e.target.checked ? state.status.add(key) : state.status.delete(key);
    loadPoints();
  });
}
$('filterBtn').onclick = () => {
  const f = $('filters');
  f.hidden = !f.hidden;
  if (!f.hidden) $('detail').hidden = true;
  $('filterBtn').classList.toggle('on', !f.hidden);
};
$('globeBtn').onclick = enterGlobe;
$('wallBtn').onclick = () => ($('wall').hidden ? openWall() : closeWall());
$('aboutBtn').onclick = () => $('about').showModal();
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-close]');
  if (!t) return;
  if (t.dataset.close === 'detail') closeDetail();
  if (t.dataset.close === 'wall') closeWall();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDetail(); closeWall(); $('results').hidden = true; }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.current && !$('detail').hidden) startFrames(state.current);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchwrap')) $('results').hidden = true;
});

// ------------------------------------------------------------------ util
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rel(ts) {
  const d = Math.round((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}
})();
