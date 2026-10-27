// adsb.lol aircraft, the military list and GPS interference derived from NACp, against small payloads in
// the upstream's own field names (readsb / ADSBExchange v2). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adsbLol, WATCH_REGIONS, MIN_AIRCRAFT } from '../src/fetchers/flights.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const T = NOW.getTime();
const ac = (hex, o = {}) => ({ hex, type: 'adsb_icao', flight: `${hex.toUpperCase()}1  `, r: `N${hex}`, t: 'B738', alt_baro: 35000, gs: 450, track: 90, lat: 41.6, lon: -81.4, nac_p: 10, version: 2, seen_pos: 2, ...o });

test('adsb-lol: catalogued open (ODbL) with terms read, served without the non-commercial switch, three layers, two on i3X', () => {
  const s = source('adsb-lol');
  assert.equal(s.license, 'open');
  assert.equal(s.fetcher, 'adsb-lol');
  assert.match(s.license_note, /ODbL/);
  assert.match(s.license_note, /2026-10-27/);
  assert.ok(s.attribution && /^https:\/\//.test(s.terms));
  assert.equal(servable(s.license, {}), true);
  for (const id of ['aircraft', 'military_aircraft', 'gps_interference']) assert.equal(LAYERS[id].source, 'adsb-lol', id);
  assert.ok(I3X_LAYERS.military_aircraft && I3X_LAYERS.gps_interference);
  assert.equal(I3X_LAYERS.aircraft, undefined, 'aircraft needs a place, so it has no default to publish');
});

test('area: aircraft around a place, privacy-programme aircraft dropped, altitude 0 on the ground, time from seen_pos', async () => {
  const f = stubFetch([[/\/v2\/point\/41\.5\/-81\.7\/60$/, res(200, { now: T, ac: [
    ac('a1b2c3'),
    ac('a00001', { alt_baro: 'ground', gs: 3, flight: '' }),
    ac('a00008', { dbFlags: 8 }), // LADD
    ac('a00004', { dbFlags: 4 }), // PIA
    ac('a00009', { lat: undefined }),
  ] })]]);
  const { status, readings } = await adsbLol.fetch(ctx(f, { places: [{ id: 'pt', name: 'Cleveland', lat: 41.5, lng: -81.7 }], params: { radius: '60' } }));
  assert.equal(status, 'ok');
  valid(readings);
  assert.deepEqual(readings.map((r) => r.fields.hex).sort(), ['a00001', 'a1b2c3']);
  const air = readings.find((r) => r.fields.hex === 'a1b2c3');
  assert.equal(air.value, 35000);
  assert.equal(air.at, new Date(T - 2000).toISOString());
  assert.equal(air.basis, undefined, 'a received position is observed');
  assert.match(air.summary, /35,000 ft, 450 kt/);
  assert.equal(readings.find((r) => r.fields.hex === 'a00001').value, 0);
});

test('area without a place is the caller\'s error; radius is bounded', async () => {
  const f = stubFetch([]);
  await assert.rejects(adsbLol.fetch(ctx(f)), (e) => e.status === 400 && /needs a place/.test(e.message));
  await assert.rejects(adsbLol.fetch(ctx(f, { places: [{ id: 'p', name: 'p', lat: 1, lng: 1 }], params: { radius: '900' } })), (e) => e.status === 400);
  assert.equal(f.calls.length, 0);
});

test('military: the worldwide list, flagged military', async () => {
  const f = stubFetch([[/\/v2\/mil$/, res(200, { now: T, ac: [ac('ae1234', { dbFlags: 1, flight: 'RCH123 ' })] })]]);
  const { readings } = await adsbLol.fetch(ctx(f, { params: { mode: 'military' } }));
  valid(readings);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].fields.military, true);
  assert.equal(readings[0].fields.callsign, 'RCH123');
});

test('gps: share of degraded aircraft per 1° cell, derived and saying from what; v0, ground and thin cells left out', async () => {
  const jammed = [...Array(8)].map((_, i) => ac(`b0000${i}`, { lat: 55.2 + i * 0.05, lon: 20.3, nac_p: i < 6 ? 0 : 10 }));
  const thin = [...Array(MIN_AIRCRAFT - 1)].map((_, i) => ac(`c0000${i}`, { lat: 57.5, lon: 18.5, nac_p: 0 }));
  const ignored = [ac('d00001', { lat: 55.5, lon: 20.5, nac_p: 0, version: 0 }), ac('d00002', { lat: 55.5, lon: 20.5, nac_p: 0, alt_baro: 'ground' })];
  const f = stubFetch([[/\/v2\/point\//, (url) => res(200, { now: T, ac: /\/56\/20\/250$/.test(url) ? [...jammed, ...thin, ...ignored] : [] })]]);
  const { readings } = await adsbLol.fetch(ctx(f, { params: { mode: 'gps' } }));
  assert.equal(f.calls.length, WATCH_REGIONS.length, 'one call per watched region when no place is named');
  valid(readings);
  assert.equal(readings.length, 1);
  const [cell] = readings;
  assert.equal(cell.metric, 'gps_interference');
  assert.equal(cell.value, 75);
  assert.equal(cell.fields.level, 'high');
  assert.deepEqual([cell.fields.aircraft, cell.fields.degraded], [8, 6]);
  assert.equal(cell.basis, 'derived');
  assert.match(cell.derived_from, /NACp/);
  assert.deepEqual([cell.place.lat, cell.place.lng], [55.5, 20.5]);
});

test('contract: basis is checked, and a derived reading must say what it came from', () => {
  const base = { id: 'x:1', at: '2026-10-10', metric: 'm', summary: 's', value: 1, source: { id: 'x', name: 'x', fetched_at: NOW.toISOString(), license: 'open' } };
  assert.deepEqual(validateReading(base), []);
  assert.deepEqual(validateReading({ ...base, basis: 'modelled' }), []);
  assert.ok(validateReading({ ...base, basis: 'guessed' }).length);
  assert.ok(validateReading({ ...base, basis: 'derived' }).length);
  assert.deepEqual(validateReading({ ...base, basis: 'derived', derived_from: 'y' }), []);
});

test('layers: each adsb layer forces its own mode and every feature carries its basis', async () => {
  const f = stubFetch([
    [/\/v2\/mil$/, res(200, { now: T, ac: [ac('ae1234', { dbFlags: 1 })] })],
    [/\/v2\/point\//, res(200, { now: T, ac: [...Array(6)].map((_, i) => ac(`e0000${i}`, { lat: 34.2, lon: 34.4 })) })],
  ]);
  const svc = createService({ fetch: f, env: {}, now: () => NOW });
  const mil = await svc.layer('military_aircraft', { mode: 'area' });
  assert.equal(mil.features.length, 1);
  assert.equal(mil.features[0].properties.basis, 'observed');
  assert.equal(mil.source.attribution, source('adsb-lol').attribution);
  const gps = await svc.layer('gps_interference', {});
  assert.ok(gps.features.length >= 1);
  assert.equal(gps.features[0].properties.basis, 'derived');
  assert.equal(gps.features[0].properties.level, 'low');
  await assert.rejects(svc.layer('aircraft', {}), (e) => e.status === 400);
  const near = await svc.layer('aircraft', { lat: '34', lng: '34' });
  assert.equal(near.features.length, 6);
});

test('gps: a region that fails is left out and said so; all failing is an error', async () => {
  const ok = [...Array(6)].map((_, i) => ac(`f0000${i}`, { lat: 26.3, lon: 52.2 }));
  const f = stubFetch([[/\/v2\/point\/26\.5\//, res(200, { now: T, ac: ok })], [/\/v2\/point\//, res(500, 'down')]]);
  const r = await adsbLol.fetch(ctx(f, { params: { mode: 'gps' } }));
  assert.equal(r.readings.length, 1);
  assert.match(r.detail, /4 of 5 places did not answer/);
  await assert.rejects(adsbLol.fetch(ctx(stubFetch([[/./, res(500, 'down')]]), { params: { mode: 'gps' } })), (e) => e.status === 500);
});

test('gps: one degraded aircraft in a cell is a faulty box, not interference', async () => {
  const cell = [...Array(6)].map((_, i) => ac(`g0000${i}`, { lat: 41.2, lon: -85.5, nac_p: i === 0 ? 0 : 10 }));
  const f = stubFetch([[/\/v2\/point\//, res(200, { now: T, ac: cell })]]);
  const { readings } = await adsbLol.fetch(ctx(f, { places: [{ id: 'p', name: 'p', lat: 41, lng: -85 }], params: { mode: 'gps' } }));
  assert.equal(readings[0].value, 16.7);
  assert.equal(readings[0].fields.level, 'low');
});
