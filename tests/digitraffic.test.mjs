// Digitraffic AIS ships, joined to the vessel list, against payloads in Digitraffic's own shape. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { digitrafficAis, shipKind } from '../src/fetchers/digitraffic.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const loc = (mmsi, lng, lat, sog = 10, navStat = 0) => ({ mmsi, type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { mmsi, sog, cog: 90, navStat, rot: 0, posAcc: true, raim: false, heading: 511, timestamp: 10, timestampExternal: NOW.getTime() - 60000 } });
const LOCS = { type: 'FeatureCollection', dataUpdatedTime: NOW.toISOString(), features: [loc(1, 24.9, 60.1), loc(2, 22, 60.4, 0, 5), loc(3, 21, 63, 6), loc(4, 25, 60.2, 102.3), loc(5, 19, 59)] };
const VESSELS = [{ mmsi: 1, name: 'BALTIC TRADER', shipType: 70, destination: 'HELSINKI', imo: 9000001, draught: 72 }, { mmsi: 2, name: 'FERRY ONE', shipType: 60 },
  { mmsi: 3, name: 'SUMMER DREAM', shipType: 37 }, { mmsi: 4, name: 'TANKER X', shipType: 84 }];
const routes = () => stubFetch([[/ais\/v1\/locations$/, res(200, LOCS)], [/ais\/v1\/vessels$/, res(200, VESSELS)]]);

test('digitraffic-ais: catalogued CC BY with the required wording, keyless, served, a layer on i3X', () => {
  const s = source('digitraffic-ais');
  assert.equal(s.license, 'open');
  assert.match(s.attribution, /Fintraffic \/ digitraffic\.fi, license CC 4\.0 BY/);
  assert.match(s.license_note, /2026-10-27/);
  assert.equal(servable(s.license, {}), true);
  assert.ok(LAYERS.ships_baltic && I3X_LAYERS.ships_baltic);
  assert.deepEqual([70, 84, 61, 30, 52, 35].map(shipKind), ['cargo', 'tanker', 'passenger', 'fishing', 'tug', 'other']);
});

test('ships joined to names and types; pleasure craft dropped and counted; gzip asked for; 102.3 kn is no speed', async () => {
  const f = routes();
  const r = await digitrafficAis.fetch(ctx(f));
  valid(r.readings);
  assert.ok(f.calls.every((c) => c.init.headers['Accept-Encoding'] === 'gzip' && c.init.headers['Digitraffic-User']));
  assert.deepEqual(r.readings.map((x) => x.fields.mmsi).sort(), [1, 2, 4, 5]);
  assert.match(r.detail, /1 pleasure and sailing craft left out/);
  const t = r.readings.find((x) => x.fields.mmsi === 1);
  assert.deepEqual([t.place.name, t.fields.kind, t.fields.destination, t.fields.draught_m, t.fields.heading_deg, t.value], ['BALTIC TRADER', 'cargo', 'HELSINKI', 7.2, null, 10]);
  assert.match(r.readings.find((x) => x.fields.mmsi === 2).summary, /moored/);
  assert.equal(r.readings.find((x) => x.fields.mmsi === 4).value, null);
  assert.equal(r.readings.find((x) => x.fields.mmsi === 5).place.name, 'MMSI 5', 'a ship missing from the vessel list keeps its MMSI');
});

test('type and bbox narrow it', async () => {
  assert.deepEqual((await digitrafficAis.fetch(ctx(routes(), { params: { type: 'tanker' } }))).readings.map((x) => x.fields.mmsi), [4]);
  assert.deepEqual((await digitrafficAis.fetch(ctx(routes(), { params: { bbox: '24,59.5,26,61' } }))).readings.map((x) => x.fields.mmsi).sort(), [1, 4]);
  await assert.rejects(digitrafficAis.fetch(ctx(routes(), { params: { bbox: 'x' } })), (e) => e.status === 400);
});

test('layer: ships_baltic carries kind and destination, attribution travels', async () => {
  const L = await createService({ fetch: routes(), env: {}, now: () => NOW }).layer('ships_baltic', {});
  assert.equal(L.features.length, 4);
  assert.equal(L.source.attribution, source('digitraffic-ais').attribution);
  assert.equal(L.features.find((x) => x.properties.kind === 'cargo').properties.destination, 'HELSINKI');
});
