// Data centers from OpenStreetMap (committed table) and SEC full-text search by topic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { osmDataCenters, dataCenterTable } from '../src/fetchers/data-centers.js';
import { secFilings, roleOf } from '../src/fetchers/sec-filings.js';
import { validateReading, servable } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));

test('catalogue: OSM data centers open (ODbL), SEC filings public domain and asking for a User-Agent, not a key', () => {
  const o = source('osm-data-centers'), s = source('sec-filings');
  assert.equal(o.license, 'open'); assert.match(o.attribution, /OpenStreetMap contributors/);
  assert.equal(s.license, 'public_domain'); assert.equal(s.auth.env, 'SEC_USER_AGENT');
  assert.ok(servable(o.license, {}) && servable(s.license, {}));
  assert.ok(LAYERS.data_centers && I3X_LAYERS.data_centers);
});

test('data center table: thousands of sites, operators normalised, ODbL said in the file', () => {
  const t = dataCenterTable();
  assert.ok(t.all.length > 3000, `${t.all.length} sites`);
  assert.match(t.license, /ODbL/);
  const ops = new Set(t.all.map((s) => s.operator));
  for (const o of ['Amazon Web Services', 'Microsoft', 'Google', 'Meta', 'Equinix', 'Digital Realty']) assert.ok(ops.has(o), o);
  assert.ok(!ops.has('AWS') && !ops.has('Amazon'), 'spellings folded');
  assert.ok(t.all.some((s) => s.status === 'construction'));
});

test('data_centers: operator, status and bbox narrow it', async () => {
  const ms = (await osmDataCenters.fetch(ctx(null, { params: { operator: 'microsoft' } }))).readings;
  assert.ok(ms.length > 20 && ms.every((r) => r.fields.operator === 'Microsoft'));
  valid(ms);
  const built = (await osmDataCenters.fetch(ctx(null, { params: { status: 'construction' } }))).readings;
  assert.ok(built.length > 0 && built.every((r) => /under construction/.test(r.summary)));
  const va = (await osmDataCenters.fetch(ctx(null, { params: { bbox: '-78,38.7,-77.2,39.2' } }))).readings;
  assert.ok(va.length > 20, `Loudoun County, Virginia: ${va.length}`);
  await assert.rejects(osmDataCenters.fetch(ctx(null, { params: { status: 'x' } })), (e) => e.status === 400);
});

test('roles: SIC code, a few name and ticker corrections', () => {
  assert.equal(roleOf('7370', 'Meta Platforms, Inc.'), 'cloud, software or hosting');
  assert.equal(roleOf('6798', 'Equinix'), 'data-center landlord (REIT)');
  assert.equal(roleOf('3679', 'Vertiv Holdings Co', ['VRT']), 'power, cooling and electrical equipment');
  assert.equal(roleOf('3674', 'Lattice'), 'chips and components');
  assert.equal(roleOf('6199', 'Cipher Digital Inc.'), 'bitcoin miner or host turning to AI');
  assert.equal(roleOf('6221', 'AIB Data Centers Inc.'), 'data-center developer or operator');
  assert.equal(roleOf('3443', 'Launch Two Acquisition Corp.'), 'blank-check company (SPAC)');
  assert.equal(roleOf('4911', 'NextEra'), 'power and utilities');
  assert.equal(roleOf('4813', 'KT Corp'), 'telecom');
});

const hit = (adsh, file, name, sic, form = '8-K', date = '2026-10-09') => ({ _id: `${adsh}:${file}`, _source: { adsh, ciks: ['0001674101'], display_names: [name], sics: [sic], form, file_date: date, file_type: 'EX-99.1', file_description: 'PRESS RELEASE', biz_locations: ['Westerville, OH'], biz_states: ['OH'], items: ['8.01'] } });

test('sec-filings: not configured without a User-Agent; one reading per filing, no place, document linked', async () => {
  const none = await secFilings.fetch(ctx(stubFetch([])));
  assert.equal(none.status, 'not_configured');
  const f = stubFetch([[/efts\.sec\.gov\/LATEST\/search-index\?/, res(200, { hits: { total: { value: 3 }, hits: [
    hit('0001674101-26-000050', 'ex99.htm', 'Vertiv Holdings Co  (VRT)  (CIK 0001674101)', '3679'),
    hit('0001674101-26-000050', 'ex99-2.htm', 'Vertiv Holdings Co  (VRT)  (CIK 0001674101)', '3679'),
    hit('0001326801-26-000099', 'meta-10q.htm', 'Meta Platforms, Inc.  (META)  (CIK 0001326801)', '7370', '10-Q'),
  ] } })]]);
  const r = await secFilings.fetch(ctx(f, { env: { SEC_USER_AGENT: 'test contact@example.org' }, params: { days: '7' } }));
  valid(r.readings);
  assert.equal(r.readings.length, 2, 'two exhibits of one filing are one reading');
  const v = r.readings.find((x) => x.fields.tickers.includes('VRT'));
  assert.deepEqual([v.place, v.fields.role, v.fields.company, v.fields.office], [null, 'power, cooling and electrical equipment', 'Vertiv Holdings Co', 'Westerville, OH']);
  assert.equal(v.source.url, 'https://www.sec.gov/Archives/edgar/data/1674101/000167410126000050/ex99.htm');
  assert.equal(f.calls[0].init.headers['User-Agent'], 'test contact@example.org');
  assert.match(f.calls[0].url, /forms=8-K,6-K,10-Q,10-K,S-1,424B4&/, 'commas literal, no slashed form');
  assert.match(f.calls[0].url, /startdt=2026-10-03&enddt=2026-10-10/);
  await assert.rejects(secFilings.fetch(ctx(f, { env: { SEC_USER_AGENT: 'x' }, params: { days: '400' } })), (e) => e.status === 400);
});

test('layer: data_centers features carry operator and status', async () => {
  const L = await createService({ fetch: stubFetch([]), env: {}, now: () => NOW }).layer('data_centers', { operator: 'Equinix' });
  assert.ok(L.features.length > 50);
  assert.ok(L.features.every((x) => x.properties.operator === 'Equinix' && x.properties.basis === 'observed'));
});
