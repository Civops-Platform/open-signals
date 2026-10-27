// Reclamation RISE reservoir storage, batched by item id, against payloads in RISE's JSON:API shape. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usbrRise, riseReservoirs, REGIONS, BATCH } from '../src/fetchers/usbr-rise.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const row = (itemId, day, result) => ({ attributes: { itemId, dateTime: `2026-10-${day}T07:00:00+00:00`, result, status: 'provisional' } });
const days = (id, start, step) => ['10', '09', '08', '07', '06', '05', '04', '03', '02'].map((d, i) => row(id, d, start - i * step));
const ids = (url) => decodeURIComponent(new URL(url).searchParams.get('itemId')).split(',').map(Number);

test('usbr-rise: catalogued public domain with terms read, a list of ~215 western reservoirs, a layer on i3X', () => {
  const s = source('usbr-rise');
  assert.equal(s.license, 'public_domain');
  assert.match(s.license_note, /2026-10-27/);
  assert.ok(s.attribution && /^https:\/\//.test(s.terms));
  assert.equal(servable(s.license, {}), true);
  const list = riseReservoirs();
  assert.ok(list.length > 150, `${list.length} reservoirs`);
  assert.equal(new Set(list.map((r) => r.item_id)).size, list.length);
  assert.ok(list.every((r) => r.lat > 25 && r.lat < 50 && r.lng < -95 && r.lng > -125 && ['af', 'taf'].includes(r.unit)), 'western US');
  assert.ok(REGIONS().includes('Missouri Basin'));
  assert.ok(LAYERS.reservoirs_west && I3X_LAYERS.reservoirs_west);
});

test('latest storage per reservoir with the week\'s change; batched; thousand-acre-feet scaled; a failed batch is counted', async () => {
  const list = riseReservoirs();
  const taf = list.find((r) => r.unit === 'taf');
  const af = list.find((r) => r.unit === 'af');
  let n = 0;
  const f = stubFetch([[/rise\/api\/result\?/, (url) => {
    n += 1;
    if (n === 2) return res(500, 'down');
    const want = ids(url);
    return res(200, { data: want.flatMap((id) => (id === af.item_id ? days(id, 160000, 1000) : id === taf?.item_id ? days(id, 2400, 2) : [])), links: {} });
  }]]);
  const r = await usbrRise.fetch(ctx(f));
  assert.equal(f.calls.length, Math.ceil(list.length / BATCH));
  assert.ok(f.calls.every((c) => ids(c.url).length <= BATCH && /dateTime%5Bafter%5D=2026-09-30/.test(c.url)));
  assert.match(r.detail, /did not answer/);
  valid(r.readings);
  const a = r.readings.find((x) => x.fields.rise_item_id === af.item_id);
  if (a) {
    assert.equal(a.value, 160000);
    assert.equal(a.fields.change_7d_af, 7000);
    assert.match(a.summary, /up 7,000 in a week/);
  }
  const t = taf && r.readings.find((x) => x.fields.rise_item_id === taf.item_id);
  if (t) assert.equal(t.value, 2400000);
  assert.ok(a || t, 'at least one of the two answered');
});

test('region narrows it and is checked', async () => {
  const f = stubFetch([[/rise\/api\/result\?/, res(200, { data: [], links: {} })]]);
  await usbrRise.fetch(ctx(f, { params: { region: 'missouri basin' } }));
  const mo = riseReservoirs().filter((r) => r.region === 'Missouri Basin').map((r) => r.item_id);
  assert.deepEqual(f.calls.flatMap((c) => ids(c.url)).sort(), mo.sort());
  await assert.rejects(usbrRise.fetch(ctx(f, { params: { region: 'Mars' } })), (e) => e.status === 400);
});

test('layer: reservoirs_west features carry the week\'s change', async () => {
  const first = riseReservoirs()[0];
  const svc = createService({ fetch: stubFetch([[/rise\/api\/result\?/, (url) => res(200, { data: ids(url).includes(first.item_id) ? days(first.item_id, 5000, -10) : [], links: {} })]]), env: {}, now: () => NOW });
  const L = await svc.layer('reservoirs_west', {});
  assert.equal(L.features.length, 1);
  assert.equal(L.features[0].properties.change_7d_af, first.unit === 'taf' ? -70000 : -70);
});
