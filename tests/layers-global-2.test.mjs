// Open-Meteo river discharge (GloFAS) and air quality (CAMS) at fixed world lists, and Smithsonian GVP
// volcanoes, against payloads recorded from the real upstreams on 2026-10-10/11 (tests/fixtures). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openMeteoFlood, openMeteoAir, worldRivers, worldCities, usAqiCategory } from '../src/fetchers/open-meteo-global.js';
import { smithsonianVolcanoes } from '../src/fetchers/volcanoes-world.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const LAYERS_2 = { river_discharge: 'open-meteo-flood', air_quality: 'open-meteo-air', volcanoes_world: 'smithsonian-gvp' };
const RIVERS_2 = [{ id: 'river-amazon-obidos', name: 'Amazon at Obidos', river: 'Amazon', country: 'BRA', lat: -2.02, lng: -55.46 },
  { id: 'river-rhine-lobith', name: 'Rhine at Lobith', river: 'Rhine', country: 'NLD', lat: 51.85, lng: 6 }];
const CITIES_3 = [{ id: 'city-delhi-ind', name: 'Delhi', country: 'IND', lat: 28.6, lng: 77.2 }, { id: 'city-london-gbr', name: 'London', country: 'GBR', lat: 51.5, lng: -0.13 },
  { id: 'city-cape-town-zaf', name: 'Cape Town', country: 'ZAF', lat: -33.92, lng: 18.42 }];

test('layers 2: catalogued non-commercial (Open-Meteo, GVP) with a terms URL read this session, an i3X folder, served only when the operator says non-commercial', () => {
  for (const [id, src] of Object.entries(LAYERS_2)) {
    assert.equal(LAYERS[id].source, src, id);
    assert.ok(LAYERS[id].events, `${id} is an event layer, so a UTC day ahead of US Eastern does not hide it`);
    const s = source(src);
    assert.equal(s.license, 'non_commercial', `${src} licence`);
    assert.match(s.terms, /^https:\/\//, `${src} terms`);
    assert.match(s.license_note, /2026-10-10/, `${src} says when the terms were read`);
    assert.ok(s.attribution, `${src} attribution`);
    assert.ok(I3X_LAYERS[id], `${id} on i3X`);
    assert.equal(servable(s.license, {}), false);
    assert.equal(servable(s.license, { OPEN_SIGNALS_NONCOMMERCIAL: '1' }), true);
  }
  assert.equal(source('open-meteo-flood').terms, 'https://open-meteo.com/en/terms');
  assert.equal(source('smithsonian-gvp').terms, 'https://volcano.si.edu/gvp_termsofuse.cfm');
  const g = source('gdacs');
  assert.deepEqual([g.license, g.fetcher], ['unknown', null], 'GDACS stays unreviewed and unserved');
});

test('world lists: about a hundred river locations and 150 cities, each placed, ids unique', () => {
  const rivers = worldRivers(), cities = worldCities();
  assert.ok(rivers.length >= 100 && rivers.length <= 130, `${rivers.length} rivers`);
  assert.equal(cities.length, 150);
  for (const list of [rivers, cities]) {
    assert.equal(new Set(list.map((p) => p.id)).size, list.length);
    assert.ok(list.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && /^[A-Z]{3}$/.test(p.country)));
  }
  assert.ok(rivers.every((p) => p.river && p.mean_30d_m3s >= 0));
  assert.ok(new Set(cities.map((c) => c.country)).size > 60, 'spread over many countries');
});

test('river discharge: today per location, week-ago change, ensemble median and 30-day ensemble high; GloFAS cell kept', async () => {
  const f = stubFetch([[/flood-api\.open-meteo\.com\/v1\/flood/, () => res(200, fx('openmeteo-flood.json'))]]);
  const { status, readings } = await openMeteoFlood.fetch(ctx(f, { places: RIVERS_2 }));
  assert.equal(status, 'ok');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /daily=river_discharge,river_discharge_median,river_discharge_max&past_days=8&forecast_days=30/);
  assert.match(f.calls[0].url, /latitude=-2\.02,51\.85&longitude=-55\.46,6/);
  valid(readings);
  assert.equal(readings.length, 2);
  const [amazon, rhine] = readings;
  assert.equal(amazon.id, 'open-meteo-flood:river-amazon-obidos:2026-10-10');
  assert.equal(amazon.at, '2026-10-10');
  assert.equal(amazon.unit, 'm³/s');
  assert.equal(amazon.source.license, 'non_commercial');
  const daily = JSON.parse(fx('openmeteo-flood.json'))[0].daily;
  const i = daily.time.indexOf('2026-10-10');
  assert.equal(amazon.value, daily.river_discharge[i]);
  assert.equal(amazon.fields.week_ago_m3s, daily.river_discharge[i - 7]);
  assert.equal(amazon.fields.ensemble_median_m3s, daily.river_discharge_median[i]);
  assert.equal(amazon.fields.peak_30d_ensemble_max_m3s, Math.max(...daily.river_discharge_max.slice(i + 1)));
  assert.ok(amazon.value > 10000, 'the snapped cell is the main stem of the Amazon, not a creek');
  assert.equal(amazon.fields.river, 'Amazon');
  assert.ok(Number.isFinite(rhine.fields.change_7d_pct));
  assert.match(rhine.summary, /^Rhine at Lobith 2026-10-10: [\d,]+ m³\/s, [+-][\d.]+% on a week ago; ensemble high/);
});

test('river discharge: with no places named it reads the world list, 50 locations a request', async () => {
  const one = JSON.parse(fx('openmeteo-flood.json'))[0];
  const f = stubFetch([[/flood-api/, (url) => res(200, new URL(url).searchParams.get('latitude').split(',').map(() => one))]]);
  const { readings } = await openMeteoFlood.fetch(ctx(f));
  const n = worldRivers().length;
  assert.equal(f.calls.length, Math.ceil(n / 50));
  assert.ok(f.calls.every((c) => new URL(c.url).searchParams.get('latitude').split(',').length <= 50));
  assert.equal(readings.length, n);
});

test('air quality: current US AQI with its category, PM2.5, PM10 and European AQI per city, at the UTC hour', async () => {
  const f = stubFetch([[/air-quality-api\.open-meteo\.com\/v1\/air-quality/, () => res(200, fx('openmeteo-air.json'))]]);
  const { readings } = await openMeteoAir.fetch(ctx(f, { places: CITIES_3 }));
  assert.match(f.calls[0].url, /current=pm2_5,pm10,us_aqi,european_aqi&timezone=GMT/);
  valid(readings);
  assert.equal(readings.length, 3);
  const [delhi, london] = readings;
  assert.equal(delhi.at, '2026-10-11T00:00:00.000Z');
  assert.deepEqual([delhi.value, delhi.fields.us_aqi_category, delhi.fields.pm2_5_ugm3, delhi.fields.pm10_ugm3, delhi.fields.european_aqi], [155, 'unhealthy', 59.3, 182.1, 77]);
  assert.equal(london.fields.us_aqi_category, 'good');
  assert.match(delhi.summary, /^Delhi 2026-10-11 00:00 UTC: US AQI 155 \(unhealthy\), PM2\.5 59\.3/);
  assert.equal(delhi.source.license, 'non_commercial');
  assert.deepEqual([0, 50, 51, 101, 151, 201, 301, null].map(usAqiCategory),
    ['good', 'good', 'moderate', 'unhealthy for sensitive groups', 'unhealthy', 'very unhealthy', 'hazardous', null]);
});

test('air quality: the 150 world cities in three requests; an ad-hoc place with no coordinates is skipped, not sent', async () => {
  const one = JSON.parse(fx('openmeteo-air.json'))[0];
  const f = stubFetch([[/air-quality-api/, (url) => res(200, new URL(url).searchParams.get('latitude').split(',').map(() => one))]]);
  const { readings } = await openMeteoAir.fetch(ctx(f));
  assert.equal(f.calls.length, 3);
  assert.equal(readings.length, 150);
  const g = stubFetch([[/air-quality-api/, () => res(200, one)]]);
  const out = await openMeteoAir.fetch(ctx(g, { places: [{ id: 'coops-1', name: '', lat: null, lng: null }] }));
  assert.deepEqual([out.readings.length, g.calls.length], [0, 0]);
});

const gvpStub = () => stubFetch([
  [/Smithsonian_VOTW_Holocene_Volcanoes/, () => res(200, fx('gvp-volcanoes.json'))],
  [/E3WebApp_Eruptions1960/, () => res(200, fx('gvp-continuing.json'))],
]);

test('volcanoes_world: Holocene volcanoes since 1900, continuing eruptions marked with their start; no photo credits asked for', async () => {
  const f = gvpStub();
  const { readings } = await smithsonianVolcanoes.fetch(ctx(f));
  const vq = decodeURIComponent(f.calls.find((c) => /Holocene_Volcanoes/.test(c.url)).url);
  assert.match(vq, /CQL_FILTER=Last_Eruption_Year>=1900/);
  assert.match(vq, /maxFeatures=2000/);
  assert.ok(!/Photo|Geological_Summary/.test(vq), 'captions, credits and summaries are not requested');
  assert.match(decodeURIComponent(f.calls.find((c) => /Eruptions1960/.test(c.url)).url), /ContinuingEruption='True'/);
  valid(readings);
  assert.equal(readings.length, 4, 'Langila erupts but is not in the volcano answer, so it is not invented');
  const by = Object.fromEntries(readings.map((r) => [r.place.name, r]));
  assert.deepEqual([by.Kilauea.value, by.Kilauea.at, by.Kilauea.fields.continuing_eruption, by.Kilauea.fields.vei_max], [2026, '2024-12-23', true, 1]);
  assert.match(by.Kilauea.summary, /^Kilauea \(United States\): erupting, continuing since 2024-12-23, VEI up to 1 so far/);
  assert.equal(by.Stromboli.fields.eruption_start, '1934-02-02');
  assert.deepEqual([by.Tanaga.value, by.Tanaga.at, by.Tanaga.fields.continuing_eruption, by.Tanaga.fields.date_precision], [1914, '1914-01-01', false, 'year']);
  assert.equal(by.Tanaga.source.url, 'https://volcano.si.edu/volcano.cfm?vn=311080');
  assert.equal(by.Tanaga.source.license, 'non_commercial');
});

test('volcanoes_world: continuing=true keeps eruptions in progress; erupted_since is a year from 1500, else 400', async () => {
  const { readings } = await smithsonianVolcanoes.fetch(ctx(gvpStub(), { params: { continuing: 'true' } }));
  assert.deepEqual(readings.map((r) => r.place.name).sort(), ['Kilauea', 'Stromboli']);
  const f = gvpStub();
  await smithsonianVolcanoes.fetch(ctx(f, { params: { erupted_since: '1960' } }));
  assert.match(decodeURIComponent(f.calls[0].url), /Last_Eruption_Year>=1960/);
  const yearOnly = fx('gvp-continuing.json').replace('"StartDate":"19340202"', '"StartDate":null');
  const g = stubFetch([[/Holocene_Volcanoes/, () => res(200, fx('gvp-volcanoes.json'))], [/Eruptions1960/, () => res(200, yearOnly)]]);
  const stromboli = (await smithsonianVolcanoes.fetch(ctx(g))).readings.find((r) => r.place.name === 'Stromboli');
  assert.deepEqual([stromboli.at, stromboli.fields.date_precision], ['1934-01-01', 'year'], 'an eruption with only a start year (Yasur: 1270) keeps that year');
  assert.match(stromboli.summary, /continuing since 1934,/);
  for (const bad of ['1499', 'recent', '2027', '1950.5']) {
    await assert.rejects(smithsonianVolcanoes.fetch(ctx(gvpStub(), { params: { erupted_since: bad } })), (e) => e.status === 400, bad);
  }
});

test('layers 2 through layer(): 451 on a public server; GeoJSON with source and attribution when the operator sets non-commercial', async () => {
  const fetch = stubFetch([
    [/flood-api/, () => res(200, fx('openmeteo-flood.json'))], [/air-quality-api/, () => res(200, fx('openmeteo-air.json'))],
    [/Holocene_Volcanoes/, () => res(200, fx('gvp-volcanoes.json'))], [/Eruptions1960/, () => res(200, fx('gvp-continuing.json'))],
  ]);
  const pub = createService({ now: () => NOW, env: {}, fetch });
  await assert.rejects(pub.layer('air_quality', {}, { mode: 'serve' }), (e) => e.status === 451);
  const service = createService({ now: () => NOW, env: { OPEN_SIGNALS_NONCOMMERCIAL: '1' }, fetch });
  const q = { river_discharge: { lat: '-2.02', lng: '-55.46', name: 'Amazon at Obidos' }, air_quality: { lat: '28.6', lng: '77.2', name: 'Delhi' }, volcanoes_world: {} };
  const counts = {};
  for (const id of Object.keys(LAYERS_2)) {
    const g = await service.layer(id, q[id], { mode: 'serve' });
    assert.equal(g.type, 'FeatureCollection');
    assert.equal(g.source.id, LAYERS_2[id]);
    assert.equal(g.source.license, 'non_commercial');
    assert.ok(g.source.attribution, `${id} carries its attribution`);
    assert.ok(g.features.every((ft) => Number.isFinite(ft.geometry.coordinates[0]) && ft.properties.url), id);
    counts[id] = g.features.length;
  }
  // one ad-hoc place each: the stub answers with the recorded list and only the first entry is read
  assert.deepEqual(counts, { river_discharge: 1, air_quality: 1, volcanoes_world: 4 });
  const vw = await service.layer('volcanoes_world', {}, { mode: 'serve' });
  assert.equal(vw.features.find((ft) => ft.properties.summary.startsWith('Kilauea')).properties.continuing_eruption, true);
});
