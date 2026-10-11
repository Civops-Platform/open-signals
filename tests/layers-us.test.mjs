// USDA AMS lock tonnage, BTS border crossings, EPA TRI and EPA CAMPD against payloads recorded from the
// real upstreams on 2026-10-10 (tests/fixtures, trimmed to a few ports, facilities and days). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { amsBargeLocks, btsBorderCrossings, epaTri, epaCampd, parseCsv, AMS_LOCKS } from '../src/fetchers/us-freight-emissions.js';
import { validateReading } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const NEW_LAYERS = { lock_traffic: 'usda-ams-barge', border_crossings: 'bts-border-crossings', toxic_releases: 'epa-tri', power_emissions: 'epa-campd' };
const notYet = () => res(404, '{"error":"not found"}');

const routes = () => [
  [/agtransport\.usda\.gov\/resource\/n4pw-9ygw/, () => res(200, fx('ams-barge-locks.json'))],
  [/keg4-3bc2\.json\?\$select=/, () => res(200, fx('bts-maxdate.json'))],
  [/keg4-3bc2\.json\?\$where=/, () => res(200, fx('bts-border-crossings.json'))],
  [/mv_tri_basic_download\/2025_/, notYet],
  [/mv_tri_basic_download\/2024_OH/, () => res(200, fx('tri-basic-oh-2024.csv'))],
  [/emissions-daily-2026-/, () => res(403, '<Error>AccessDenied</Error>')],
  [/emissions-daily-2025-oh\.csv/, () => res(200, fx('campd-daily-2025-oh.csv'))],
  [/facility\/facility-2025\.csv/, () => res(200, fx('campd-facility-2025.csv'))],
];

test('US layers: catalogued public domain with a terms URL and an i3X folder; CAMPD keyless now; OSHA says why it is not fetched', () => {
  for (const [id, src] of Object.entries(NEW_LAYERS)) {
    assert.equal(LAYERS[id].source, src, id);
    const s = source(src);
    assert.equal(s.license, 'public_domain', src);
    assert.match(s.terms, /^https:\/\//, `${src} terms`);
    assert.equal(s.auth, null, `${src} is keyless`);
    assert.ok(I3X_LAYERS[id], `${id} on i3X`);
  }
  assert.equal(source('osha').fetcher, null);
  assert.equal(source('osha').auth.env, 'DOL_API_KEY');
});

test('parseCsv: quotes, doubled quotes, commas and newlines inside a field, CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n1,\n'), [['a', 'b'], ['x, y', 'say "hi"\nthere'], ['1', '']]);
});

test('lock_traffic: latest week per lock summed over commodities, four-week average, at the USACE lock position', async () => {
  const f = stubFetch(routes());
  const { readings } = await amsBargeLocks.fetch(ctx(f));
  assert.match(decodeURIComponent(f.calls[0].url), /\$order=date DESC&\$limit=300/);
  valid(readings);
  assert.equal(readings.length, 7);
  assert.ok(readings.every((r) => r.place && r.at === '2026-10-03'), 'all seven locks are known and current');
  const rows = JSON.parse(fx('ams-barge-locks.json'));
  const want = rows.filter((r) => r.lock === 'MS Locks 27' && r.date.startsWith('2026-10-03')).reduce((a, r) => a + Number(r.tons), 0);
  const l27 = readings.find((r) => r.fields.lock_label === 'MS Locks 27');
  assert.equal(l27.value, want);
  assert.deepEqual([l27.place.lat, l27.place.lng], [AMS_LOCKS['MS Locks 27'].lat, AMS_LOCKS['MS Locks 27'].lng]);
  assert.equal(l27.place.name, 'Chain of Rocks Lock 27');
  const prior = ['2026-09-26', '2026-09-19', '2026-09-12', '2026-09-05'].map((d) => rows.filter((r) => r.lock === 'MS Locks 27' && r.date.startsWith(d)).reduce((a, r) => a + Number(r.tons), 0));
  assert.equal(l27.fields.prior_4wk_avg_tons, Math.round(prior.reduce((a, b) => a + b) / 4));
  assert.equal(l27.source.license, 'public_domain');
});

test('lock_traffic: a lock label we cannot place is kept, unplaced, not guessed', async () => {
  const rows = [{ date: '2026-10-03T00:00:00.000', commodity: 'Corn', lock: 'TN Lock X', tons: '100' }];
  const { readings } = await amsBargeLocks.fetch(ctx(stubFetch([[/agtransport/, () => res(200, rows)]])));
  assert.equal(readings[0].place, null);
  assert.equal(readings[0].value, 100);
});

test('border_crossings: latest month asked first, one reading per port, trucks the value, other measures kept', async () => {
  const f = stubFetch(routes());
  const { readings } = await btsBorderCrossings.fetch(ctx(f));
  assert.match(decodeURIComponent(f.calls[1].url), /date='2026-08-01T00:00:00\.000'&\$limit=5000/);
  valid(readings);
  assert.equal(readings.length, 5);
  const by = Object.fromEntries(readings.map((r) => [r.fields.port_name, r]));
  const rows = JSON.parse(fx('bts-border-crossings.json'));
  const det = (m) => Number(rows.find((r) => r.port_name === 'Detroit' && r.measure === m).value);
  assert.equal(by.Detroit.value, det('Trucks'));
  assert.equal(by.Detroit.fields.trains, det('Trains'));
  assert.equal(by.Detroit.at, '2026-08-01');
  assert.equal(by.Detroit.fields.border, 'US-Canada Border');
  assert.ok(Number.isFinite(by.Laredo.place.lat) && by.Laredo.place.lng < -99);
  const g = stubFetch(routes());
  await btsBorderCrossings.fetch(ctx(g, { params: { border: 'mexico' } }));
  assert.match(decodeURIComponent(g.calls[1].url), /border='US-Mexico Border'/);
});

test('toxic_releases: newest published year found (2025 not yet), forms summed per facility in pounds, dioxin grams apart, no names of people', async () => {
  const f = stubFetch(routes());
  const { readings } = await epaTri.fetch(ctx(f));
  assert.match(f.calls[0].url, /2025_OH\/csv$/);
  assert.match(f.calls[1].url, /2024_OH\/csv$/);
  valid(readings);
  assert.equal(readings.length, 3);
  const ford = readings.find((r) => r.fields.tri_facility_id === '45241FRDMT3000S');
  const forms = parseCsv(fx('tri-basic-oh-2024.csv'));
  const h = forms[0].map((x) => x.replace(/^\d+\.\s*/, ''));
  const ix = (n) => h.indexOf(n);
  const fordRows = forms.slice(1).filter((r) => r[ix('TRIFD')] === '45241FRDMT3000S');
  assert.equal(ford.value, Math.round(fordRows.reduce((a, r) => a + Number(r[ix('ON-SITE RELEASE TOTAL')]), 0) * 10) / 10);
  assert.equal(ford.at, '2024-12-31');
  assert.equal(ford.place.name, 'FORD MOTOR CO SHARONVILLE PLANT');
  assert.equal(ford.fields.forms, fordRows.length);
  const dioxin = readings.find((r) => r.fields.tri_facility_id === '43616SHLCM4001C');
  assert.ok(dioxin.fields.dioxin_grams > 0, 'grams kept apart');
  const gramRows = forms.slice(1).filter((r) => r[ix('TRIFD')] === '43616SHLCM4001C' && r[ix('UNIT OF MEASURE')] === 'Pounds');
  assert.equal(dioxin.value, Math.round(gramRows.reduce((a, r) => a + Number(r[ix('ON-SITE RELEASE TOTAL')]), 0) * 10) / 10);
  const text = JSON.stringify(readings);
  assert.ok(!/contact|certif/i.test(text), 'no contact or certifying-official fields');
  const g = stubFetch([[/2025_TX/, notYet], [/2024_TX/, () => res(200, fx('tri-basic-oh-2024.csv'))]]);
  await epaTri.fetch(ctx(g, { params: { state: 'tx' } }));
  assert.match(g.calls[1].url, /2024_TX/);
});

test('power_emissions: current-year file not out (403) so last year; the latest month summed per facility; placed from the facility file', async () => {
  const f = stubFetch(routes());
  const { readings } = await epaCampd.fetch(ctx(f));
  assert.match(f.calls[0].url, /emissions-daily-2026-oh\.csv$/);
  assert.match(f.calls[1].url, /emissions-daily-2025-oh\.csv$/);
  assert.match(f.calls[2].url, /facility-2025\.csv$/);
  assert.ok(f.calls.every((c) => !/api_key|DEMO_KEY/i.test(c.url)), 'no key on any call');
  valid(readings);
  assert.equal(readings.length, 2);
  const card = readings.find((r) => r.fields.facility_id === '2828');
  const rows = parseCsv(fx('campd-daily-2025-oh.csv'));
  const h = rows[0];
  const dec = rows.slice(1).filter((r) => r[2] === '2828' && r[5].startsWith('2025-12'));
  assert.equal(card.value, Math.round(dec.reduce((a, r) => a + Number(r[h.indexOf('CO2 Mass (short tons)')] || 0), 0) * 10) / 10);
  assert.equal(card.at, '2025-12-31');
  assert.equal(card.fields.month, '2025-12');
  assert.equal(card.place.name, 'Cardinal');
  assert.ok(card.place.lat > 38 && card.place.lng < -80);
  assert.ok(card.fields.ytd_co2_tons >= card.value);
  assert.ok(!('primary_rep_info' in card.fields), 'designated-representative ids are dropped');
});

test('US layers through layer(): GeoJSON events with source and licence', async () => {
  const service = createService({ now: () => NOW, env: {}, fetch: stubFetch(routes()) });
  const counts = {};
  for (const id of Object.keys(NEW_LAYERS)) {
    const g = await service.layer(id, {}, { mode: 'serve' });
    assert.equal(g.type, 'FeatureCollection');
    assert.equal(g.source.id, NEW_LAYERS[id]);
    assert.equal(g.source.license, 'public_domain');
    assert.ok(g.source.attribution || id === 'power_emissions' || id === 'toxic_releases', `${id} attribution`);
    assert.ok(g.features.every((ft) => Number.isFinite(ft.geometry.coordinates[0]) && ft.properties.url), id);
    counts[id] = g.features.length;
  }
  assert.deepEqual(counts, { lock_traffic: 7, border_crossings: 5, toxic_releases: 3, power_emissions: 2 });
});
