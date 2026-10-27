// NWS active alerts, placed per county from SAME codes, against a payload in api.weather.gov's own shape. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nwsAlerts } from '../src/fetchers/nws-alerts.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const alert = (id, event, same, geometry = null, extra = {}) => ({ id: `https://api.weather.gov/alerts/${id}`, geometry,
  properties: { '@id': `https://api.weather.gov/alerts/${id}`, id, event, severity: 'Severe', urgency: 'Expected', certainty: 'Likely', sent: '2026-10-10T14:00:00-04:00',
    onset: '2026-10-10T16:00:00-04:00', ends: '2026-10-11T08:00:00-04:00', expires: '2026-10-10T22:00:00-04:00', senderName: 'NWS Cleveland OH', messageType: 'Alert',
    headline: `${event} issued October 10 by NWS Cleveland OH`, areaDesc: 'Cuyahoga; Lake', geocode: { SAME: same }, ...extra } });
const PAYLOAD = { type: 'FeatureCollection', features: [
  alert('a1', 'Red Flag Warning', ['039035', '039085']),
  alert('a2', 'Wind Advisory', ['039035']),
  alert('a3', 'Gale Warning', ['096147']),
  alert('a4', 'Small Craft Advisory', ['097148'], { type: 'Polygon', coordinates: [[[-82, 41.6], [-81, 41.6], [-81, 42], [-82, 42], [-82, 41.6]]] }),
] };

test('nws-alerts: catalogued public domain with terms read, keyless, a layer on i3X', () => {
  const s = source('nws-alerts');
  assert.equal(s.license, 'public_domain');
  assert.equal(s.auth, null);
  assert.match(s.license_note, /2026-10-27/);
  assert.ok(s.attribution && /^https:\/\//.test(s.terms));
  assert.equal(servable(s.license, {}), true);
  assert.equal(LAYERS.weather_alerts.source, 'nws-alerts');
  assert.ok(I3X_LAYERS.weather_alerts);
});

test('one reading per alert per county at its internal point; marine alerts left out and counted', async () => {
  const f = stubFetch([[/alerts\/active\?status=actual$/, res(200, PAYLOAD)]]);
  const r = await nwsAlerts.fetch(ctx(f));
  valid(r.readings);
  assert.deepEqual(r.readings.map((x) => x.id).sort(), ['nws-alerts:a1:39035', 'nws-alerts:a1:39085', 'nws-alerts:a2:39035']);
  const rf = r.readings.find((x) => x.id === 'nws-alerts:a1:39035');
  assert.equal(rf.value, 3);
  assert.equal(rf.fields.event, 'Red Flag Warning');
  assert.equal(rf.place.id, 'fips-39035');
  assert.ok(Math.abs(rf.place.lat - 41.4) < 0.5 && Math.abs(rf.place.lng + 81.7) < 0.5, 'Cuyahoga County');
  assert.match(r.detail, /2 marine or offshore alerts left out/);
});

test('kind, event and state narrow it; marine=true places a marine alert at its polygon', async () => {
  const f = stubFetch([[/alerts\/active\?status=actual(&area=OH)?$/, res(200, PAYLOAD)]]);
  assert.deepEqual((await nwsAlerts.fetch(ctx(f, { params: { kind: 'warning' } }))).readings.map((x) => x.fields.event), ['Red Flag Warning', 'Red Flag Warning']);
  assert.equal((await nwsAlerts.fetch(ctx(f, { params: { event: 'wind advisory' } }))).readings.length, 1);
  const m = await nwsAlerts.fetch(ctx(f, { params: { marine: 'true', state: 'oh' } }));
  assert.match(f.calls.at(-1).url, /&area=OH$/);
  const sca = m.readings.find((x) => x.fields.event === 'Small Craft Advisory');
  assert.deepEqual([sca.place.lat, sca.place.lng], [41.8, -81.5]);
  assert.match(m.detail, /1 alerts with no county or polygon/);
  await assert.rejects(nwsAlerts.fetch(ctx(f, { params: { state: 'ZZ' } })), (e) => e.status === 400);
});

test('layer: weather_alerts features carry event and severity', async () => {
  const svc = createService({ fetch: stubFetch([[/alerts\/active/, res(200, PAYLOAD)]]), env: {}, now: () => NOW });
  const L = await svc.layer('weather_alerts', {});
  assert.equal(L.features.length, 3);
  assert.equal(L.features[0].properties.basis, 'observed');
  assert.ok(L.features.every((x) => x.properties.event && x.properties.severity === 'Severe'));
});
