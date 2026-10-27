// Corroboration: USGS × EMSC earthquakes and NIFC incidents × FIRMS detections, against payloads in each
// upstream's own shape. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { corroboration, QUAKE_KM } from '../src/fetchers/corroborate.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const T = Date.parse('2026-10-10T12:00:00Z');
const usgs = (id, lng, lat, mag, dtS = 0) => ({ id, geometry: { coordinates: [lng, lat, 10] }, properties: { mag, magType: 'mb', place: `place ${id}`, time: T + dtS * 1000, url: `https://earthquake.usgs.gov/${id}`, status: 'reviewed', tsunami: 0, type: 'earthquake' } });
const emscEv = (id, lng, lat, mag, auth, dtS = 0) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lng, lat, -10] },
  properties: { unid: id, time: new Date(T + dtS * 1000).toISOString(), lat, lon: lng, depth: 10, mag, magtype: 'mb', auth, flynn_region: `REGION ${id}`, evtype: 'ke', lastupdate: new Date(T).toISOString() } });
const QUAKES = [
  [/earthquake\.usgs\.gov\/earthquakes\/feed/, res(200, { features: [usgs('us1', 170, -20, 5.1), usgs('us2', -98.9, 28.9, 2.6), usgs('us3', -150, 60, 3.0)] })],
  [/seismicportal\.eu\/fdsnws/, res(200, { type: 'FeatureCollection', features: [emscEv('e1', 170.1, -20.05, 5.0, 'EMSC', 3), emscEv('e2', -98.9, 28.9, 2.6, 'NEIC'), emscEv('e3', 20, 38, 3.2, 'NOA'), emscEv('e4', -150, 60, 3.0, 'AK', 600)] })],
];

test('corroboration: catalogued as derived, licence open (strictest input CC BY), servable, two layers on i3X', () => {
  const s = source('corroboration');
  assert.equal(s.license, 'open');
  assert.match(s.license_note, /CC BY 4\.0/);
  assert.ok(s.attribution.includes('EMSC'));
  assert.equal(servable(s.license, {}), true);
  for (const id of ['quake_corroboration', 'fire_corroboration']) { assert.equal(LAYERS[id].source, 'corroboration'); assert.ok(I3X_LAYERS[id]); }
});

test('earthquakes: independent agreement counts 2, a relayed USGS-network solution counts once, singles from either side kept', async () => {
  const { readings } = await corroboration.fetch(ctx(stubFetch(QUAKES), { params: { min: 'all' } }));
  valid(readings);
  const by = (k, v) => readings.find((r) => r.fields[k] === v);
  const tonga = by('usgs_id', 'usgs-earthquakes:us1');
  assert.deepEqual([tonga.value, tonga.fields.corroborated, tonga.fields.relayed, tonga.fields.mag_gap, tonga.fields.time_gap_s], [2, true, false, 0.1, 3]);
  assert.ok(tonga.fields.distance_km < QUAKE_KM);
  assert.equal(tonga.basis, 'derived');
  const texas = by('usgs_id', 'usgs-earthquakes:us2');
  assert.deepEqual([texas.value, texas.fields.relayed, texas.fields.emsc_agency], [1, true, 'NEIC']);
  assert.match(texas.summary, /one source, not two/);
  const alaska = by('usgs_id', 'usgs-earthquakes:us3');
  assert.equal(alaska.fields.emsc_id, null, '10 minutes apart is not the same event');
  assert.equal(readings.filter((r) => r.fields.usgs_id === null).length, 2, 'EMSC-only events kept (Greece, and the late Alaska one)');
  assert.equal(readings.length, 5);
});

test('fires: each incident with the VIIRS detections within 5 km in the last 24 h', async () => {
  const HEAD = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
  const firms = [HEAD, '44.80,-120.20,330,0.4,0.4,2026-10-10,0812,N20,nominal,2.0NRT,290,7.5,N', '44.81,-120.21,330,0.4,0.4,2026-10-10,0954,N20,high,2.0NRT,290,4.5,D', '30,-90,330,0.4,0.4,2026-10-10,0954,N20,high,2.0NRT,290,9,D'].join('\n');
  const inc = (id, x, y, acres) => ({ attributes: { UniqueFireIdentifier: id, IncidentName: id, IncidentTypeCategory: 'WF', IncidentSize: acres, PercentContained: 20, FireDiscoveryDateTime: T - 86400e3, ModifiedOnDateTime_dt: T, POOState: 'US-OR' }, geometry: { x, y } });
  const f = stubFetch([
    [/J1_VIIRS_C2_Global_24h\.csv$/, res(200, firms)],
    [/WFIGS_Incident_Locations_Current\/FeatureServer\/0\/query/, res(200, { features: [inc('2026-OR-1', -120.199, 44.803, 342923), inc('2026-OR-2', -118, 43, 12)] })],
  ]);
  const { readings } = await corroboration.fetch(ctx(f, { params: { mode: 'fires' } }));
  valid(readings);
  const [big, small] = ['2026-OR-1', '2026-OR-2'].map((id) => readings.find((r) => r.fields.unique_fire_id === id));
  assert.deepEqual([big.value, big.fields.frp_mw, big.fields.corroborated], [2, 12, true]);
  assert.equal(big.at, '2026-10-10T09:54:00Z', 'time of the latest detection');
  assert.deepEqual([small.value, small.fields.corroborated], [0, false]);
  assert.match(small.summary, /not|no satellite heat/);
  assert.ok(readings.every((r) => r.basis === 'derived'));
});

test('layer: quake_corroboration features say relayed or corroborated', async () => {
  const svc = createService({ fetch: stubFetch(QUAKES), env: {}, now: () => NOW });
  const L = await svc.layer('quake_corroboration', { min: 'all' });
  assert.equal(L.features.length, 5);
  assert.equal(L.features.filter((x) => x.properties.relayed).length, 1);
  assert.ok(L.features.every((x) => x.properties.basis === 'derived'));
});
