/**
 * Validate a Windy Webcams key and the assumptions this project makes about
 * the free tier:  node scripts/windy-check.mjs
 */
import { config } from '../src/config.js';
import '../src/sources/index.js';
import { resolveImageUrl } from '../src/resolvers.js';

const API = 'https://api.windy.com/webcams/api/v3/webcams';
const key = config.windyApiKey;

if (!key) {
  console.log('No WINDY_API_KEY found.\n');
  console.log('  1. Get a free key at https://api.windy.com/keys');
  console.log('  2. echo "WINDY_API_KEY=your-key-here" >> .env');
  console.log('  3. re-run this check, then restart the server');
  process.exit(1);
}
console.log(`key loaded (${key.slice(0, 4)}…${key.slice(-4)}, ${key.length} chars)\n`);

const call = async (path) => {
  const r = await fetch(API + path, {
    headers: { 'x-windy-api-key': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
};

let failed = 0;
const check = async (name, fn) => {
  try { console.log(`  ok   ${name} — ${await fn()}`); }
  catch (e) { failed++; console.log(`  FAIL ${name} — ${e.message}`); }
};

await check('key is accepted', async () => {
  const j = await call('?limit=1');
  return `${j.total ?? '?'} webcams visible in total`;
});

let sharding = false;
await check('country filter (needed to pass the 1000-offset cap)', async () => {
  const j = await call('?limit=1&countries=IN');
  sharding = true;
  return `India: ${j.total ?? '?'} webcams`;
});

await check('india sample with location + images', async () => {
  const j = await call('?limit=3&countries=IN&include=location,images,urls');
  const w = j.webcams?.[0];
  if (!w) return 'no Indian webcams returned';
  return `${w.title} @ ${w.location?.latitude?.toFixed(3)},${w.location?.longitude?.toFixed(3)}`;
});

await check('resolver mints a working image URL', async () => {
  const j = await call('?limit=1&countries=IN&include=images');
  const w = j.webcams?.[0];
  if (!w) throw new Error('no webcam to test');
  const url = await resolveImageUrl({ source: 'windy', native_id: String(w.webcamId), image_url: null });
  if (!url) throw new Error('resolver returned nothing');
  const img = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await img.arrayBuffer());
  if (!img.ok) throw new Error(`image fetch HTTP ${img.status}`);
  return `${img.headers.get('content-type')}, ${(buf.length / 1024).toFixed(0)} KB`;
});

console.log(
  failed
    ? `\n${failed} check(s) failed — see above`
    : `\nall checks passed. Sharding by country is ${sharding ? 'available' : 'NOT available'}.` +
      `\nRun "npm run ingest" then restart the server to pull Windy cameras in.`
);
process.exit(failed ? 1 : 0);
