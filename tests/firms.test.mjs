// NASA FIRMS fires, persistent heat and steel-plant heat, against small CSVs in the upstream's own columns,
// and the committed GEM steel table. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nasaFirms, steelPlants, nearestSteelPlant, MAX_FIRES } from '../src/fetchers/firms.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const HEAD = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
const row = (lat, lng, date, frp = 5, conf = 'nominal', time = '0742', sat = 'N') => `${lat},${lng},330.1,0.4,0.4,${date},${time},${sat},${conf},2.0NRT,290.2,${frp},N`;
const csv = (rows) => [HEAD, ...rows].join('\n') + '\n';
const GARY = { lat: 41.6208, lng: -87.34827 };
const DATES = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];

test('nasa-firms: catalogued public domain with terms read, keyless, four layers, two on i3X', () => {
  const s = source('nasa-firms');
  assert.equal(s.license, 'public_domain');
  assert.equal(s.auth, null, 'the global CSV files need no key');
  assert.equal(s.fetcher, 'nasa-firms');
  assert.match(s.license_note, /2026-10-27/);
  assert.ok(s.attribution && /^https:\/\//.test(s.terms));
  assert.equal(servable(s.license, {}), true);
  for (const id of ['fires', 'persistent_heat', 'steel_plant_heat']) assert.equal(LAYERS[id].source, 'nasa-firms', id);
  assert.ok(I3X_LAYERS.persistent_heat && I3X_LAYERS.steel_plant_heat);
});

test('steel table: GEM plants with owners, no shareholder placeholders, positions in range', () => {
  const { all, hot, release } = steelPlants();
  assert.match(release, /^\d{4}-\d{2}$/);
  assert.ok(all.length > 900, `${all.length} plants`);
  assert.ok(hot.length > 400 && hot.every((p) => /BF|DRI/.test(p.prod_type)));
  assert.ok(all.every((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180));
  assert.ok(!all.some((p) => /natural person|unknown|small shareholder/i.test(`${p.owner} ${p.parent}`)), 'no placeholder shareholders');
  const gary = nearestSteelPlant(GARY);
  assert.equal(gary.name, 'U.S. Steel Gary Works');
  assert.match(gary.parent, /Nippon Steel/);
  assert.equal(nearestSteelPlant({ lat: 0, lng: -150 }), null, 'mid-Pacific has none within 3 km');
});

test('fires: low confidence dropped, bbox applied, strongest kept above the cap, said so', async () => {
  const many = Array.from({ length: MAX_FIRES + 2 }, (_, i) => row(40 + (i % 100) / 1000, -100 - Math.floor(i / 100) / 1000, '2026-10-10', i));
  const f = stubFetch([[/J1_VIIRS_C2_Global_24h\.csv$/, res(200, csv([...many, row(41, -100, '2026-10-10', 99999, 'low'), row(10, 10, '2026-10-10', 50)]))]]);
  const r = await nasaFirms.fetch(ctx(f, { params: { bbox: '-110,30,-90,45' } }));
  valid(r.readings.slice(0, 50));
  assert.equal(r.readings.length, MAX_FIRES);
  assert.match(r.detail, new RegExp(`${MAX_FIRES + 2} detections`));
  assert.ok(!r.readings.some((x) => x.value === 99999), 'low confidence never served');
  assert.ok(!r.readings.some((x) => x.place.lat === 10), 'outside bbox');
  assert.equal(r.readings[0].at, '2026-10-10T07:42:00Z');
  assert.equal(r.readings[0].basis, undefined, 'a detection is observed');
  await assert.rejects(nasaFirms.fetch(ctx(f, { params: { bbox: '1,2,3' } })), (e) => e.status === 400);
});

test('persistent: a cell hot on 3+ dates is derived heat, named after the steel plant beside it; a moving fire is not', async () => {
  const mill = DATES.slice(0, 6).map((d) => row(GARY.lat + 0.001, GARY.lng + 0.001, d, 12));
  const fire = DATES.slice(0, 3).map((d, i) => row(45 + i * 0.05, -110, d, 40)); // moves ~5 km a day
  const f = stubFetch([[/SUOMI_VIIRS_C2_Global_7d\.csv$/, res(200, csv([...mill, ...fire, row(1, 1, DATES[7], 1)]))]]);
  const { readings } = await nasaFirms.fetch(ctx(f, { params: { mode: 'persistent' } }));
  valid(readings);
  assert.equal(readings.length, 1);
  const [h] = readings;
  assert.equal(h.value, 6);
  assert.equal(h.fields.of_days, 7, 'denominator is the dates the file holds');
  assert.equal(h.basis, 'derived');
  assert.match(h.derived_from, /FIRMS/);
  assert.equal(h.fields.near_steel_plant.name, 'U.S. Steel Gary Works');
  assert.match(h.place.name, /Gary Works/);
  assert.match(h.summary, /6 of the last 7 UTC dates/);
});

test('steel: every BF/DRI plant, with heat days near it (zero included), owner and parent', async () => {
  const f = stubFetch([[/SUOMI_VIIRS_C2_Global_7d\.csv$/, res(200, csv([...DATES.map((d) => row(GARY.lat, GARY.lng + 0.01, d, 20)), row(GARY.lat + 0.2, GARY.lng, DATES[0], 20)]))]]);
  const { readings } = await nasaFirms.fetch(ctx(f, { params: { mode: 'steel' } }));
  valid(readings.slice(0, 20));
  assert.equal(readings.length, steelPlants().hot.length);
  const gary = readings.find((x) => x.place.name === 'U.S. Steel Gary Works');
  assert.deepEqual([gary.value, gary.fields.of_days, gary.fields.detections], [8, 8, 8]);
  assert.equal(gary.basis, 'derived');
  assert.match(gary.fields.parent, /Nippon Steel/);
  assert.ok(readings.filter((x) => x.value === 0).length > 100, 'plants with no heat are still listed');
});

test('layers: fires observed, steel heat derived, attribution travels', async () => {
  const f = stubFetch([
    [/J1_VIIRS_C2_Global_24h\.csv$/, res(200, csv([row(41, -100, '2026-10-10', 9)]))],
    [/SUOMI_VIIRS_C2_Global_7d\.csv$/, res(200, csv(DATES.map((d) => row(GARY.lat, GARY.lng, d, 20))))],
  ]);
  const svc = createService({ fetch: f, env: {}, now: () => NOW });
  const fires = await svc.layer('fires', { mode: 'steel' });
  assert.equal(fires.features.length, 1);
  assert.equal(fires.features[0].properties.basis, 'observed');
  assert.equal(fires.source.attribution, source('nasa-firms').attribution);
  const steel = await svc.layer('steel_plant_heat', {});
  const g = steel.features.find((x) => x.properties.place_ref.name === 'U.S. Steel Gary Works');
  assert.equal(g.properties.basis, 'derived');
  assert.equal(g.properties.owner, 'United States Steel Corp');
});
