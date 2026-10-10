// Fetchers against canned upstream responses. No network.
// Ported from Civops-Platform/signals tests/waterfowl.test.mjs and usda.test.mjs,
// now asserting the open-signals reading shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWsi, wsiStatus, WSI_THRESHOLDS } from '../src/fetchers/wsi.js';
import { openMeteo, waterfowlWsi } from '../src/fetchers/open-meteo.js';
import { coops, glerlIce, usgsWater } from '../src/fetchers/water.js';
import { ebird } from '../src/fetchers/ebird.js';
import { usdaNass, buildCropReadings, parseShortDesc, NASS_COMMODITIES } from '../src/fetchers/usda-nass.js';
import { usgsEarthquakes } from '../src/fetchers/usgs-earthquakes.js';
import { validateReading } from '../src/contract.js';
import { source, PLACES } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx, omDaily, quakes } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const MAUMEE = PLACES.find((p) => p.id === 'maumee-bay');
const TOLEDO = PLACES.find((p) => p.id === 'coops-toledo');

test('WSI reproduces Schummer et al. 2010 Table 2 worked example (−2, 4, 19)', () => {
  const out = computeWsi([
    { date: 'd1', temp_mean_c: 2, snow_depth_cm: 0 },
    { date: 'd2', temp_mean_c: -1, snow_depth_cm: 3 },
    { date: 'd3', temp_mean_c: -5, snow_depth_cm: 26 },
  ]);
  assert.deepEqual(out.map((d) => Math.round(d.wsi)), [-2, 4, 19]);
  assert.equal(out[2].wsi, 19.24);
});

test('WSI: a missing day breaks the streaks rather than being assumed frozen', () => {
  const out = computeWsi([
    { date: 'a', temp_mean_c: -3, snow_depth_cm: 5 },
    { date: 'b', temp_mean_c: null, snow_depth_cm: null },
    { date: 'c', temp_mean_c: -3, snow_depth_cm: 5 },
  ]);
  assert.equal(out[1].wsi, null);
  assert.equal(out[2].temp_days, 1);
  assert.deepEqual({ ...WSI_THRESHOLDS }, { mallard: 7.2, other_dabblers: -4.6 });
  assert.deepEqual(wsiStatus(8), { mallard_past_threshold: true, other_dabblers_past_threshold: true });
});

test('open-meteo: snow m→cm, today onward is forecast, day-over-day pressure, every reading valid', async () => {
  const f = stubFetch([[/api\.open-meteo\.com/, () => res(200, omDaily)]]);
  const { status, readings } = await openMeteo.fetch(ctx(f, { places: [MAUMEE] }));
  assert.equal(status, 'ok');
  assert.match(f.calls[0].url, /timezone=auto/);
  assert.equal(readings.length, 3);
  valid(readings);
  assert.equal(readings[0].fields.snow_depth_cm, 3);
  assert.deepEqual(readings.map((r) => !!r.forecast), [false, true, true]);
  assert.equal(readings[1].fields.pressure_change_hpa, 8);
  assert.equal(readings[1].source.license, 'non_commercial');
  assert.equal(readings[0].place.id, 'maumee-bay');
});

test('waterfowl-wsi: one reading per day, value from the paper formula', async () => {
  const f = stubFetch([[/api\.open-meteo\.com/, () => res(200, omDaily)]]);
  const { readings } = await waterfowlWsi.fetch(ctx(f, { places: [MAUMEE] }));
  assert.equal(readings.length, 3);
  valid(readings);
  assert.equal(readings[1].value, 7.97); // 2 + 2 + 5*0.394 + 2
  assert.equal(readings[1].source.id, 'waterfowl-wsi');
});

test('co-ops: 6-minute readings aggregate to a local-day mean; blanks skipped, not zero', async () => {
  const f = stubFetch([[/tidesandcurrents/, () => res(200, { data: [
    { t: '2026-10-10 12:00', v: '2.600' }, { t: '2026-10-10 12:06', v: '2.700' }, { t: '2026-10-10 12:12', v: '' },
  ] })]]);
  const { readings } = await coops.fetch(ctx(f, { places: [TOLEDO] }));
  assert.equal(readings.length, 1);
  valid(readings);
  assert.equal(readings[0].id, 'noaa-coops:9063085:2026-10-10');
  assert.equal(readings[0].value, 2.65);
  assert.equal(readings[0].fields.readings, 2);
});

test('co-ops: an ad-hoc station takes its name and position from the upstream metadata', async () => {
  const f = stubFetch([[/tidesandcurrents/, () => res(200, { metadata: { id: '8518750', name: 'The Battery', lat: '40.7006', lon: '-74.0142' }, data: [{ t: '2026-10-10 12:00', v: '3.1' }] })]]);
  const { readings } = await coops.fetch(ctx(f, { places: [{ id: 'coops-8518750', name: '', lat: null, lng: null, refs: { coops: '8518750' } }] }));
  assert.equal(readings[0].place.name, 'The Battery');
  assert.equal(readings[0].place.lat, 40.7006);
});

test('co-ops: a tidal station with no LWD is read against MLLW and says so; other 400s still throw', async () => {
  const f = stubFetch([
    [/datum=LWD/, () => res(400, '{"error": {"message":" There is no LWD for the station: 8518750"}}')],
    [/datum=MLLW/, () => res(200, { metadata: { name: 'The Battery', lat: '40.7', lon: '-74.0' }, data: [{ t: '2026-10-10 12:00', v: '3.1' }] })],
  ]);
  const { readings } = await coops.fetch(ctx(f, { places: [{ id: 'c', name: '', lat: null, lng: null, refs: { coops: '8518750' } }] }));
  assert.equal(readings[0].unit, 'ft above MLLW');
  assert.equal(readings[0].fields.datum, 'MLLW');
  assert.match(readings[0].summary, /mean lower low water/);
  const bad = stubFetch([[/tidesandcurrents/, () => res(400, '{"error": {"message":"Wrong station ID"}}')]]);
  await assert.rejects(coops.fetch(ctx(bad, { places: [{ id: 'c', refs: { coops: '1' } }] })), /400/);
});

test('usgs-water: keeps only discharge and gage height, positioned from the feature geometry', async () => {
  const f = stubFetch([[/waterdata\.usgs\.gov/, () => res(200, { features: [
    { geometry: { coordinates: [-83.71, 41.5] }, properties: { parameter_code: '00060', value: '1230', unit_of_measure: 'ft^3/s', time: '2026-10-10T14:45:00Z', approval_status: 'Provisional' } },
    { geometry: { coordinates: [-83.71, 41.5] }, properties: { parameter_code: '00010', value: '12', time: '2026-10-10T14:45:00Z' } },
  ] })]]);
  const { readings } = await usgsWater.fetch(ctx(f, { places: [{ id: 'usgs-x', name: '', lat: null, lng: null, refs: { usgs: 'USGS-04193500' } }] }));
  assert.equal(readings.length, 1);
  valid(readings);
  assert.equal(readings[0].metric, 'river_discharge');
  assert.equal(readings[0].value, 1230);
  assert.equal(readings[0].place.lat, 41.5);
});

test('glerl: out-of-range 404 is off_season; other failures throw; rows become one reading per lake', async () => {
  const off = stubFetch([[/glerl/, () => res(404, 'Your query produced no matching results. (time>=2026-09-19 is outside of the variable\'s actual_range')]]);
  assert.equal((await glerlIce.fetch(ctx(off))).status, 'off_season');
  const down = stubFetch([[/glerl/, () => res(503, 'Service Unavailable')]]);
  await assert.rejects(glerlIce.fetch(ctx(down)), /503/);
  const on = stubFetch([[/glerl/, () => res(200, { table: { columnNames: ['time', 'Erie', 'Huron'], rows: [['2026-02-01T00:00:00Z', 95.17, null]] } })]]);
  const { status, readings } = await glerlIce.fetch(ctx(on));
  assert.equal(status, 'ok');
  assert.equal(readings.length, 1, 'a null lake is skipped, not zero');
  valid(readings);
  assert.equal(readings[0].id, 'glerl:lake-erie:2026-02-01');
});

test('ebird: no key → not_configured with no request', async () => {
  const f = stubFetch([]);
  const r = await ebird.fetch(ctx(f, { places: PLACES }));
  assert.equal(r.status, 'not_configured');
  assert.equal(f.calls.length, 0);
});

test('ebird: value is the latest single report per species, never a sum; non-waterfowl dropped', async () => {
  const f = stubFetch([
    [/taxonomy/, () => res(200, [{ speciesCode: 'mallar3', comName: 'Mallard', familySciName: 'Anatidae' }, { speciesCode: 'amerob', comName: 'American Robin', familySciName: 'Turdidae' }])],
    [/data\/obs/, () => res(200, [
      { speciesCode: 'mallar3', howMany: 40, obsDt: '2026-10-08 07:00', locId: 'L1' },
      { speciesCode: 'mallar3', howMany: 12, obsDt: '2026-10-09 07:00', locId: 'L2' },
      { speciesCode: 'amerob', howMany: 3, obsDt: '2026-10-09 07:00', locId: 'L2' },
    ])],
  ]);
  const lucas = PLACES.find((p) => p.refs?.ebird === 'US-OH-095');
  const { readings } = await ebird.fetch(ctx(f, { env: { EBIRD_API_KEY: 'k' }, places: [lucas], sleep: async () => {} }));
  assert.equal(readings.length, 1);
  valid(readings);
  assert.equal(readings[0].value, 12);
  assert.equal(f.calls[1].init.headers['X-eBirdApiToken'], 'k');
});

const rec = (o) => ({ week_ending: '2026-10-04', agg_level_desc: 'STATE', state_alpha: 'OH', state_name: 'OHIO', ...o });

test('nass: parseShortDesc splits crop and stage', () => {
  assert.deepEqual(parseShortDesc('CORN, GRAIN - PROGRESS, 5 YEAR AVG, MEASURED IN PCT HARVESTED', 'PCT HARVESTED'), { crop: 'CORN, GRAIN', stage: 'harvested' });
});

test('nass: progress joins its own 5-year average; condition is good+excellent; withheld skipped', () => {
  const src = source('usda-nass');
  const rs = buildCropReadings([
    rec({ statisticcat_desc: 'PROGRESS', short_desc: 'CORN, GRAIN - PROGRESS, MEASURED IN PCT HARVESTED', unit_desc: 'PCT HARVESTED', Value: '6' }),
    rec({ statisticcat_desc: 'PROGRESS, 5 YEAR AVG', short_desc: 'CORN, GRAIN - PROGRESS, 5 YEAR AVG, MEASURED IN PCT HARVESTED', unit_desc: 'PCT HARVESTED', Value: '14' }),
    rec({ statisticcat_desc: 'PROGRESS, 5 YEAR AVG', short_desc: 'CORN, GRAIN - PROGRESS, 5 YEAR AVG, MEASURED IN PCT HARVESTED', unit_desc: 'PCT HARVESTED', Value: '40', state_alpha: 'IA', state_name: 'IOWA' }),
    rec({ statisticcat_desc: 'PROGRESS', short_desc: 'SOYBEANS - PROGRESS, MEASURED IN PCT HARVESTED', unit_desc: 'PCT HARVESTED', Value: '(D)' }),
    ...[['EXCELLENT', '12'], ['GOOD', '53'], ['FAIR', '24']].map(([u, v]) => rec({ statisticcat_desc: 'CONDITION', agg_level_desc: 'NATIONAL', state_alpha: 'US', short_desc: `CORN - CONDITION, MEASURED IN PCT ${u}`, unit_desc: `PCT ${u}`, Value: v })),
  ], NOW, src);
  valid(rs);
  const p = rs.find((r) => r.metric === 'crop_progress');
  assert.equal(p.id, 'usda-nass:OH:corn-grain:harvested:2026-10-04');
  assert.equal(p.fields.five_year_avg, 14);
  assert.equal(p.fields.vs_five_year_avg, -8);
  const c = rs.find((r) => r.metric === 'crop_condition');
  assert.equal(c.value, 65);
  assert.equal(c.place.name, 'United States');
  assert.equal(rs.length, 2);
});

test('nass: no key → not_configured, no data → off_season, and one query per commodity × category × level', async () => {
  assert.equal((await usdaNass.fetch(ctx(stubFetch([])))).status, 'not_configured');
  const urls = [];
  const f = async (u) => { urls.push(new URL(u)); return res(400, '{"error":["no data"]}'); };
  const r = await usdaNass.fetch(ctx(f, { env: { NASS_API_KEY: 'k' } }));
  assert.equal(r.status, 'off_season');
  assert.equal(urls.length, NASS_COMMODITIES.length * 3 * 2);
  assert.ok(urls.every((u) => u.searchParams.get('year') === '2026'));
});

test('usgs-earthquakes: one reading per event at its epicentre; malformed features dropped; feed picked by params', async () => {
  const f = stubFetch([[/earthquake\.usgs\.gov/, () => res(200, quakes)]]);
  const { readings } = await usgsEarthquakes.fetch(ctx(f, { params: { window: 'week', min: '2.5' } }));
  assert.match(f.calls[0].url, /2\.5_week\.geojson$/);
  assert.equal(readings.length, 1);
  valid(readings);
  assert.deepEqual([readings[0].place.lat, readings[0].place.lng], [38.8, -122.8]);
  assert.equal(readings[0].fields.depth_km, 2.1);
  assert.equal(readings[0].source.license, 'public_domain');
  const g = stubFetch([[/earthquake\.usgs\.gov/, () => res(200, quakes)]]);
  await usgsEarthquakes.fetch(ctx(g, { params: { window: 'month; rm -rf', min: 'x' } }));
  assert.match(g.calls[0].url, /all_day\.geojson$/, 'unknown params fall back, never reach the URL');
});
