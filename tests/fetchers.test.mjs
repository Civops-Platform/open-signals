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

// ── Gap-filling layers (2026-10-10): volcanoes, river flood status, EPA facilities ──
import { usgsVolcanoes, noaaNwps, parseBbox } from '../src/fetchers/hazards.js';
import { epaEcho } from '../src/fetchers/epa-echo.js';

const VOLC = [
  { vnum: '311120', volcano_name: 'Great Sitkin', region: 'Alaska - Aleutians', latitude: 52.0765, longitude: -176.1109, elevation_meters: 1740, volcano_url: 'https://avo.alaska.edu/x' },
  { vnum: '311320', volcano_name: 'Akutan', region: 'Alaska - Aleutians', latitude: 54.134, longitude: -165.986 },
];
const MON = [
  { vnum: '311120', volcano_name: 'Great Sitkin', alert_level: 'WATCH', color_code: 'ORANGE', sent_utc: '2026-10-09 20:34:00', notice_identifier: 'N1', notice_url: 'https://volcanoes.usgs.gov/hans-public/notice/N1', obs_fullname: 'Alaska Volcano Observatory' },
  { vnum: '311320', volcano_name: 'Akutan', alert_level: 'NORMAL', color_code: 'GREEN', sent_utc: '2019-09-06 18:29:39', notice_identifier: 'N0' },
  { vnum: '999999', volcano_name: 'Nowhere', alert_level: 'ADVISORY', color_code: 'YELLOW', sent_utc: '2026-01-01 00:00:00' },
];

test('usgs-volcanoes: alert level ranked 0–3 at the volcano\'s position; unpositioned skipped; elevated filter', async () => {
  const f = stubFetch([[/getUSVolcanoes/, () => res(200, VOLC)], [/getMonitoredVolcanoes/, () => res(200, MON)]]);
  const { readings } = await usgsVolcanoes.fetch(ctx(f));
  valid(readings);
  assert.equal(readings.length, 2, 'a monitored volcano with no position is skipped, not placed at 0,0');
  const gs = readings.find((r) => r.place.name === 'Great Sitkin');
  assert.equal(gs.value, 2);
  assert.equal(gs.at, '2026-10-09T20:34:00.000Z');
  assert.equal(gs.fields.color_code, 'ORANGE');
  const f2 = stubFetch([[/getUSVolcanoes/, () => res(200, VOLC)], [/getMonitoredVolcanoes/, () => res(200, MON)]]);
  const { readings: up } = await usgsVolcanoes.fetch(ctx(f2, { params: { elevated: 'true' } }));
  assert.deepEqual(up.map((r) => r.place.name), ['Great Sitkin']);
});

const gauge = (lid, primary, cat, fcat = 'fcst_not_current', valid = '2026-10-10T18:15:00Z') => ({
  lid, name: `Gauge ${lid}`, latitude: 41.9, longitude: -83.98, state: { abbreviation: 'MI' }, rfc: { abbreviation: 'NCRFC' },
  status: { observed: { primary, primaryUnit: 'ft', secondary: 0.174, secondaryUnit: 'kcfs', floodCategory: cat, validTime: valid },
    forecast: { primary: fcat === 'fcst_not_current' ? -999 : 9.1, primaryUnit: 'ft', floodCategory: fcat, validTime: '0001-01-01T00:00:00Z' } },
});

test('noaa-nwps: stage and flood category per gauge; -999 and year-0001 sentinels are not readings', async () => {
  const f = stubFetch([[/api\.water\.noaa\.gov/, () => res(200, { gauges: [
    gauge('ADRM4', 4.56, 'no_flooding'), gauge('X1', 12.2, 'minor', 'moderate'), gauge('X2', -999, 'obs_not_current'), gauge('X3', 3, 'no_flooding', 'fcst_not_current', '0001-01-01T00:00:00Z'),
  ] })]]);
  const { readings } = await noaaNwps.fetch(ctx(f));
  valid(readings);
  assert.match(f.calls[0].url, /bbox\.xmin=-93&bbox\.ymin=40&bbox\.xmax=-75&bbox\.ymax=49/);
  assert.deepEqual(readings.map((r) => r.fields.lid), ['ADRM4', 'X1']);
  const x1 = readings[1];
  assert.equal(x1.fields.flood_rank, 2);
  assert.equal(x1.fields.forecast_category, 'moderate');
  assert.equal(readings[0].fields.forecast_category, null, 'no current forecast is null, not a category');
});

test('noaa-nwps: bbox is parsed, ordered and bounded', () => {
  assert.deepEqual(parseBbox('-84,41,-82,42'), [-84, 41, -82, 42]);
  assert.throws(() => parseBbox('-82,41,-84,42'), /bbox/);
  assert.throws(() => parseBbox('1,2,3'), /bbox/);
  assert.throws(() => parseBbox('-180,-90,180,90'), /larger than/);
});

test('epa-echo: query id then GeoJSON; state is a closed set; significant non-compliers flagged', async () => {
  const f = stubFetch([
    [/get_facilities/, () => res(200, { Results: { Message: 'Success', QueryID: '754', QueryRows: '2' } })],
    [/get_geojson/, () => res(200, { type: 'FeatureCollection', features: [
      { geometry: { coordinates: [-82.668, 39.734] }, properties: { RegistryID: '110000381989', FacName: '3 SIGMA LLC', FacCity: 'LANCASTER', FacState: 'OH', FacQtrsWithNC: 4, FacSNCFlg: 'Y', FacComplianceStatus: 'Violation Identified', FacTotalPenalties: '$12,000', FacDateLastInspection: '2025-11-06T00:00:00.000' } },
      { geometry: { coordinates: [null, null] }, properties: { RegistryID: '2', FacName: 'No position' } },
    ] })],
  ]);
  const { readings } = await epaEcho.fetch(ctx(f, { params: { state: 'oh; drop' } }));
  assert.match(f.calls[0].url, /p_st=OH&p_maj=Y$/, 'an unknown state falls back to OH, never reaches the URL');
  assert.match(f.calls[1].url, /qid=754/);
  valid(readings);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].value, 4);
  assert.equal(readings[0].fields.significant_noncomplier, true);
  assert.equal(readings[0].fields.last_inspection, '2025-11-06');
  assert.match(readings[0].summary, /significant non-complier, penalties \$12,000/);
  const bad = stubFetch([[/get_facilities/, () => res(200, { Results: { Error: { ErrorMessage: 'too many' } } })]]);
  await assert.rejects(epaEcho.fetch(ctx(bad)), /no query id/);
});
