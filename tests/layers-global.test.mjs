// EMSC, IBTrACS, Eurostat, WRI power plants and OpenFEMA against payloads recorded from the real
// upstreams on 2026-10-10 (tests/fixtures). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emsc, ibtracs } from '../src/fetchers/world-hazards.js';
import { eurostat, jsonStatRows } from '../src/fetchers/europe.js';
import { wriPowerPlants, powerPlantTable } from '../src/fetchers/power-plants.js';
import { openfema, fipsPoint } from '../src/fetchers/fema.js';
import { validateReading } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const NEW_LAYERS = { earthquakes_emsc: 'emsc', tropical_cyclones: 'noaa-ibtracs', power_plants: 'wri-gppd', eu_industrial_production: 'eurostat', fema_declarations: 'openfema' };

test('new layers: each source is catalogued with a servable licence, a terms URL read this session, and an i3X folder', () => {
  for (const [id, src] of Object.entries(NEW_LAYERS)) {
    assert.equal(LAYERS[id].source, src, id);
    const s = source(src);
    assert.ok(['public_domain', 'open'].includes(s.license), `${src} licence`);
    assert.match(s.terms, /^https:\/\//, `${src} terms`);
    assert.ok(I3X_LAYERS[id], `${id} on i3X`);
  }
  const g = source('gdacs');
  assert.equal(g.license, 'unknown', 'GDACS grants no reuse licence that we could find; it stays unserved');
  assert.equal(g.fetcher, null);
});

test('emsc: one reading per event at its epicentre, region named, agency code kept, window and floor in the query', async () => {
  const f = stubFetch([[/seismicportal\.eu\/fdsnws/, () => res(200, fx('emsc-events.json'))]]);
  const { status, readings } = await emsc.fetch(ctx(f, { params: { window: 'week', min: '4.5' } }));
  assert.equal(status, 'ok');
  assert.match(f.calls[0].url, /starttime=2026-10-03T15:00:00/);
  assert.match(f.calls[0].url, /minmag=4\.5/);
  assert.match(f.calls[0].url, /limit=1000/);
  assert.equal(readings.length, 3);
  valid(readings);
  const r = readings[0];
  assert.equal(r.id, 'emsc:20261010_0000407');
  assert.equal(r.at, '2026-10-10T23:11:03.000Z');
  assert.deepEqual([r.place.lat, r.place.lng, r.value], [36.74, 71.484, 4.2]);
  assert.equal(r.place.name, 'Hindu Kush Region, Afghanistan');
  assert.equal(r.fields.agency, 'NDI');
  assert.equal(r.fields.depth_km, 181);
  assert.equal(r.source.license, 'open');
});

test('emsc: a 204 (nothing matched) is ok with no readings, not an error', async () => {
  const f = stubFetch([[/seismicportal/, () => res(204, '')]]);
  const out = await emsc.fetch(ctx(f));
  assert.deepEqual(out, { status: 'ok', readings: [] });
  assert.ok(!/minmag/.test(f.calls[0].url), 'default floor is all');
});

test('ibtracs: the latest fix per storm, US positions and winds, longitudes past 180 folded, units row skipped', async () => {
  const f = stubFetch([[/ibtracs\.ACTIVE/, () => res(200, fx('ibtracs-active.csv'))]]);
  const { readings } = await ibtracs.fetch(ctx(f));
  valid(readings);
  assert.equal(readings.length, 3);
  const by = Object.fromEntries(readings.map((r) => [r.fields.name, r]));
  assert.equal(by.NOLO.at, '2026-10-08T00:00:00.000Z', 'last of the two NOLO fixes');
  assert.deepEqual([by.NOLO.place.lat, by.NOLO.place.lng, by.NOLO.value], [26.9, 156, 54]);
  assert.equal(by.ISAIAS.place.name, 'Isaias');
  assert.equal(by.ISAIAS.value, 60);
  assert.equal(by.ISAIAS.fields.pressure_hpa, 988);
  assert.equal(by.ISAIAS.fields.basin, 'NA');
  assert.equal(by.UNNAMED.place.name, 'Unnamed system 2026270N11220');
  assert.equal(by.UNNAMED.fields.category, 'disturbance');
  assert.equal(by.UNNAMED.source.license, 'public_domain');
});

test('ibtracs: a storm whose last fix is more than 7 days before the newest is left off', async () => {
  const csv = fx('ibtracs-active.csv').replace('2026-10-02 06:00:00', '2026-09-30 00:00:00');
  const { readings } = await ibtracs.fetch(ctx(stubFetch([[/ibtracs/, () => res(200, csv)]])));
  assert.deepEqual(readings.map((r) => r.fields.name).sort(), ['ISAIAS', 'NOLO']);
});

test('eurostat: JSON-stat unpacked; latest month per country at its capital; aggregates off the map; status spelled out', async () => {
  const f = stubFetch([[/sts_inpr_m/, () => res(200, fx('eurostat-sts_inpr_m.json'))]]);
  const { readings } = await eurostat.fetch(ctx(f));
  assert.match(f.calls[0].url, /unit=I21&s_adj=SCA/);
  valid(readings);
  const by = Object.fromEntries(readings.map((r) => [r.fields.geo, r]));
  assert.equal(by.EU27_2020, undefined, 'an aggregate has no capital');
  assert.equal(by.DE.value, 90.7);
  assert.equal(by.DE.at, '2026-08-01');
  assert.equal(by.DE.place.name, 'Germany');
  assert.equal(by.IE.fields.month, '2026-07', 'a country a month behind keeps its own latest');
  assert.equal(by.IE.fields.status, 'provisional');
  assert.equal(readings.length, 36);
  const rows = jsonStatRows(JSON.parse(fx('eurostat-sts_inpr_m.json')));
  assert.equal(rows.find((r) => r.geo === 'BE' && r.time === '2026-06').value, 88.8);
  const g = stubFetch([[/sts_inpr_m/, () => res(200, fx('eurostat-sts_inpr_m.json'))]]);
  await eurostat.fetch(ctx(g, { params: { indicator: 'industrial_production_yoy' } }));
  assert.match(g.calls[0].url, /unit=PCH_SM&s_adj=CA/);
});

test('power plants: committed table is compact and 50 MW and up; default 1000 MW worldwide, country and fuel filters, bad params are 400s', async () => {
  const t = powerPlantTable();
  assert.ok(readFileSync(new URL('../catalog/power-plants.json', import.meta.url)).length < 3e6);
  assert.ok(t.plants.length > 10000 && t.plants.every((p) => p[5] >= 50));
  const all = await wriPowerPlants.fetch(ctx(null));
  assert.ok(all.readings.length > 1000 && all.readings.every((r) => r.value >= 1000));
  valid(all.readings.slice(0, 50));
  const three = all.readings.find((r) => r.id === 'wri-gppd:WRI1000452');
  assert.equal(three.place.name, 'Three Gorges Dam');
  assert.equal(three.value, 22500);
  assert.equal(three.source.license, 'open');
  const de = await wriPowerPlants.fetch(ctx(null, { params: { country: 'deu', fuel: 'coal' } }));
  assert.ok(de.readings.length > 10 && de.readings.every((r) => r.fields.country === 'DEU' && r.fields.fuel === 'Coal' && r.value >= 50));
  await assert.rejects(wriPowerPlants.fetch(ctx(null, { params: { country: 'Germany' } })), (e) => e.status === 400);
  await assert.rejects(wriPowerPlants.fetch(ctx(null, { params: { fuel: 'unicorn' } })), (e) => e.status === 400);
  await assert.rejects(wriPowerPlants.fetch(ctx(null, { params: { min_mw: 'lots' } })), (e) => e.status === 400);
});

test('openfema: county at its Census point, tribal (county 000) at the state point, a territory with no point kept but unplaced', async () => {
  const f = stubFetch([[/fema\.gov\/api\/open\/v2\/DisasterDeclarationsSummaries/, () => res(200, fx('openfema-declarations.json'))]]);
  const { readings } = await openfema.fetch(ctx(f));
  assert.match(decodeURIComponent(f.calls[0].url), /declarationDate ge '2026-07-12T00:00:00.000Z'/);
  assert.match(f.calls[0].url, /\$top=1000/);
  valid(readings);
  assert.equal(readings.length, 3);
  const [fl, sd, mp] = readings;
  assert.equal(fl.id, 'openfema:EM-3655-FL:99023');
  assert.deepEqual(fipsPoint('12023'), { lng: -82.6234, lat: 30.2217 }, 'Columbia County, FL, from the Census Gazetteer');
  assert.deepEqual([fl.place.id, fl.place.lng, fl.place.lat], ['fips-12023', -82.6234, 30.2217]);
  assert.equal(fl.value, 2);
  assert.equal(fl.fields.placed_at, 'county');
  assert.equal(sd.place.id, 'fips-46');
  assert.equal(sd.fields.placed_at, 'state');
  assert.equal(sd.value, 3);
  assert.equal(mp.place, null, 'no Census point for the Northern Mariana Islands, so no guess');
  assert.equal(fl.source.license, 'public_domain');
});

test('new layers through layer(): GeoJSON events with source and licence; unplaced readings left off', async () => {
  const service = createService({ now: () => NOW, env: {}, fetch: stubFetch([
    [/seismicportal/, () => res(200, fx('emsc-events.json'))], [/ibtracs/, () => res(200, fx('ibtracs-active.csv'))],
    [/sts_inpr_m/, () => res(200, fx('eurostat-sts_inpr_m.json'))], [/fema\.gov/, () => res(200, fx('openfema-declarations.json'))],
  ]) });
  const counts = {};
  for (const id of Object.keys(NEW_LAYERS)) {
    const g = await service.layer(id, {}, { mode: 'serve' });
    assert.equal(g.type, 'FeatureCollection');
    assert.equal(g.source.id, NEW_LAYERS[id]);
    assert.ok(g.source.attribution, `${id} carries its attribution`);
    assert.ok(g.features.every((ft) => Number.isFinite(ft.geometry.coordinates[0]) && ft.properties.url), id);
    counts[id] = g.features.length;
  }
  assert.deepEqual({ ...counts, power_plants: counts.power_plants > 1000 }, { earthquakes_emsc: 3, tropical_cyclones: 3, power_plants: true, eu_industrial_production: 36, fema_declarations: 2 });
});
