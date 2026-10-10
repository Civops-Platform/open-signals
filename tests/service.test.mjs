// Catalogue integrity, the licence gate, place resolution, caching, layers,
// and the HTTP + MCP surfaces end to end against a stubbed upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, PLACES, validateCatalog, searchSources } from '../src/catalog.js';
import { servable, LICENSES } from '../src/contract.js';
import { FETCHERS } from '../src/fetchers/index.js';
import { createService, resolvePlaces, HttpError, LAYERS } from '../src/service.js';
import { createServer } from '../src/server.js';
import { openapi } from '../src/openapi.js';
import { TOOLS } from '../src/mcp.js';
import { NOW, res, stubFetch, omDaily, quakes } from './helpers.mjs';

test('catalogue is valid: ids, licences, topics, found_via, and every fetcher has an entry and vice versa', () => {
  assert.deepEqual(validateCatalog({ fetchers: FETCHERS }), []);
  assert.ok(SOURCES.length >= 40);
  for (const id of Object.keys(FETCHERS)) assert.equal(SOURCES.find((s) => s.id === id).fetcher, id);
});

test('catalogue validation catches a bad licence and a missing fetcher', () => {
  const errs = validateCatalog({ sources: [{ id: 'x', name: 'X', homepage: 'h', coverage: 'c', license_note: 'n', license: 'free', topics: ['a'], found_via: ['me'], fetcher: 'nope' }], places: [], fetchers: {} });
  assert.ok(errs.some((e) => /license must be/.test(e)));
  assert.ok(errs.some((e) => /fetcher 'nope'/.test(e)));
});

test('search: words, topic, licence and fetchable combine', () => {
  assert.ok(searchSources({ query: 'fires' }).some((s) => s.id === 'nasa-firms'));
  assert.ok(searchSources({ topic: 'water', license: 'public_domain', fetchable: true }).every((s) => s.fetcher && s.license === 'public_domain' && s.topics.includes('water')));
  assert.deepEqual(searchSources({ query: 'zzzz-nothing' }), []);
});

test('licence gate: public domain and open always; non-commercial only when the operator says so; never restricted or unknown', () => {
  assert.deepEqual(LICENSES.filter((l) => servable(l, {})), ['public_domain', 'open']);
  assert.ok(servable('non_commercial', { OPEN_SIGNALS_NONCOMMERCIAL: '1' }));
  assert.ok(!servable('restricted', { OPEN_SIGNALS_NONCOMMERCIAL: '1' }));
  assert.ok(!servable('unknown', { OPEN_SIGNALS_NONCOMMERCIAL: '1' }));
});

test('service refuses to republish a non-commercial source (451) but fetches it locally', async () => {
  const f = stubFetch([[/api\.open-meteo\.com/, () => res(200, omDaily)]]);
  const svc = createService({ fetch: f, env: {}, now: () => NOW });
  await assert.rejects(svc.readings('open-meteo', {}, { mode: 'serve' }), (e) => e instanceof HttpError && e.status === 451);
  assert.equal(f.calls.length, 0, 'refused before any upstream call');
  const local = await svc.readings('open-meteo', { place: 'maumee-bay' }, { mode: 'local' });
  assert.equal(local.count, 3);
});

test('places: ad-hoc point, upstream ids, named, tagged, defaults; bad input is a 400/404', () => {
  assert.equal(resolvePlaces('open-meteo', { lat: '41.5', lng: '-81.7' })[0].id, 'pt-41.500_-81.700');
  assert.deepEqual(resolvePlaces('noaa-coops', { coops: '9063085,9063079' }).map((p) => p.refs.coops), ['9063085', '9063079']);
  assert.equal(resolvePlaces('open-meteo', { place: 'maumee-bay' })[0].name, 'Maumee Bay');
  assert.ok(resolvePlaces('open-meteo', { tag: 'ice-fishing' }).every((p) => p.tags.includes('ice-fishing')));
  assert.ok(resolvePlaces('usgs-water', {}).every((p) => p.refs.usgs));
  assert.throws(() => resolvePlaces('open-meteo', { lat: '91', lng: '0' }), (e) => e.status === 400);
  assert.throws(() => resolvePlaces('noaa-coops', { coops: '../etc' }), (e) => e.status === 400);
  assert.throws(() => resolvePlaces('open-meteo', { place: 'atlantis' }), (e) => e.status === 404);
});

test('readings are cached per source, places and params', async () => {
  const f = stubFetch([[/earthquake\.usgs\.gov/, () => res(200, quakes)]]);
  const svc = createService({ fetch: f, env: {}, now: () => NOW });
  await svc.readings('usgs-earthquakes', {});
  await svc.readings('usgs-earthquakes', {});
  assert.equal(f.calls.length, 1);
  await svc.readings('usgs-earthquakes', { window: 'week' });
  assert.equal(f.calls.length, 2);
});

test('readings: limit, since and unknown sources are checked', async () => {
  const svc = createService({ fetch: stubFetch([[/earthquake/, () => res(200, quakes)]]), env: {}, now: () => NOW });
  await assert.rejects(svc.readings('usgs-earthquakes', { limit: '0' }), (e) => e.status === 400);
  await assert.rejects(svc.readings('usgs-earthquakes', { since: 'yesterday' }), (e) => e.status === 400);
  await assert.rejects(svc.readings('nope', {}), (e) => e.status === 404);
  await assert.rejects(svc.readings('nasa-firms', {}), (e) => e.status === 404 && /no fetcher/.test(e.message));
  const r = await svc.readings('usgs-earthquakes', { since: '2026-10-11' });
  assert.equal(r.count, 0);
});

test('layer: one feature per place for the date, falling back to the latest observed, never a forecast in the past', async () => {
  const f = stubFetch([[/api\.open-meteo\.com/, () => res(200, omDaily)]]);
  const svc = createService({ fetch: f, env: { OPEN_SIGNALS_NONCOMMERCIAL: '1' }, now: () => NOW });
  const today = await svc.layer('temperature', { place: 'maumee-bay' });
  assert.equal(today.features.length, 1);
  assert.equal(today.features[0].properties.date, '2026-10-10');
  assert.equal(today.features[0].properties.value, -2);
  assert.deepEqual(today.features[0].geometry.coordinates, [-83.4, 41.69]);
  const later = await svc.layer('temperature', { place: 'maumee-bay', date: '2026-10-20' });
  assert.equal(later.features[0].properties.date, '2026-10-09', 'past a gap: the latest observed, not a forecast');
  await assert.rejects(svc.layer('nope', {}), (e) => e.status === 404);
});

test('event layer: one feature per event', async () => {
  const svc = createService({ fetch: stubFetch([[/earthquake/, () => res(200, quakes)]]), env: {}, now: () => NOW });
  const l = await svc.layer('earthquakes', {});
  assert.equal(l.features.length, 1);
  assert.equal(l.source.license, 'public_domain');
  assert.equal(l.features[0].properties.value, 2.4);
});

async function withServer(env, routes, fn) {
  const service = createService({ fetch: stubFetch(routes), env, now: () => NOW });
  const srv = createServer({ service, env, log: { error() {} } }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

test('HTTP: index, sources, readings, layers, 451 for a gated source, 404s, CORS', async () => {
  await withServer({}, [[/earthquake/, () => res(200, quakes)]], async (base) => {
    const idx = await (await fetch(`${base}/`)).json();
    assert.equal(idx.catalogue.sources, SOURCES.length);
    const src = await fetch(`${base}/v1/sources?topic=fires`);
    assert.equal(src.headers.get('access-control-allow-origin'), '*');
    assert.ok((await src.json()).sources.some((s) => s.id === 'nasa-firms'));
    const one = await (await fetch(`${base}/v1/sources/usgs-earthquakes`)).json();
    assert.equal(one.servable_here, true);
    const rd = await (await fetch(`${base}/v1/readings?source=usgs-earthquakes`)).json();
    assert.equal(rd.count, 1);
    const gated = await fetch(`${base}/v1/readings?source=ebird`);
    assert.equal(gated.status, 451);
    assert.equal((await gated.json()).license, 'non_commercial');
    assert.equal((await fetch(`${base}/v1/readings`)).status, 400);
    const lay = await fetch(`${base}/v1/layers/earthquakes`);
    assert.match(lay.headers.get('content-type'), /geo\+json/);
    const cat = await (await fetch(`${base}/v1/layers`)).json();
    assert.equal(cat.layers.find((l) => l.id === 'wsi').available, false);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/v1/places`, { method: 'POST' })).status, 405);
  });
});

test('HTTP: per-IP rate limit answers 429', async () => {
  await withServer({ RATE_LIMIT_PER_MIN: '2' }, [], async (base) => {
    await fetch(`${base}/health`);
    await fetch(`${base}/health`);
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '60');
  });
});

const rpc = (base, body) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('MCP: initialize, tools/list, tools/call, resources, gated tool result, bad requests', async () => {
  await withServer({}, [[/earthquake/, () => res(200, quakes)]], async (base) => {
    const init = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'open-signals');
    const tools = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(tools.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
    const call = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_readings', arguments: { source: 'usgs-earthquakes' } } });
    assert.equal(JSON.parse(call.result.content[0].text).count, 1);
    const search = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_sources', arguments: { query: 'flights' } } });
    assert.ok(JSON.parse(search.result.content[0].text).sources.length >= 2);
    const gated = await rpc(base, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_readings', arguments: { source: 'open-meteo', lat: 41, lng: -83 } } });
    assert.equal(gated.result.isError, true);
    assert.match(gated.result.content[0].text, /non_commercial/);
    const resList = await rpc(base, { jsonrpc: '2.0', id: 6, method: 'resources/list' });
    const read = await rpc(base, { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: resList.result.resources[0].uri } });
    assert.equal(JSON.parse(read.result.contents[0].text).sources.length, SOURCES.length);
    assert.equal((await rpc(base, { jsonrpc: '2.0', id: 8, method: 'nope' })).error.code, -32601);
    assert.equal((await rpc(base, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
    assert.equal((await rpc(base, { id: 10 })).error.code, -32600);
    const note = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
  });
});

test('OpenAPI lists every REST route the server answers, and every layer', () => {
  for (const p of ['/v1/sources', '/v1/sources/{id}', '/v1/hubs', '/v1/places', '/v1/readings', '/v1/layers', '/v1/layers/{id}', '/mcp', '/health']) {
    assert.ok(openapi.paths[p], p);
  }
  assert.deepEqual(openapi.paths['/v1/layers/{id}'].get.parameters[0].schema.enum, Object.keys(LAYERS));
});

test('every layer names a source with a fetcher, and catalogue places all sit on the map', () => {
  for (const [id, L] of Object.entries(LAYERS)) assert.ok(FETCHERS[L.source], id);
  assert.ok(PLACES.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)));
});

test('a fetcher rejecting its own parameter is a 400, an upstream 400 is not', async () => {
  const svc = createService({ fetch: stubFetch([[/api\.water\.noaa\.gov/, () => res(400, 'upstream says no')]]), env: {}, now: () => NOW });
  await assert.rejects(svc.readings('noaa-nwps', { bbox: 'nonsense' }), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(svc.readings('noaa-nwps', {}), (e) => !(e instanceof HttpError) && e.status === 400 && e.body === 'upstream says no');
});

// ── Static datasets ──
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatasets } from '../src/datasets.js';

function dataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-data-'));
  mkdirSync(path.join(dir, 'fire'), { recursive: true });
  writeFileSync(path.join(dir, 'fire', 'OH.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-82, 40] }, properties: { name: 'x' } }] }));
  writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ datasets: [
    { id: 'fire', label: 'Fire', kind: 'polygons', part_by: 'state', source: 'NIFC', license: 'public_domain', features: 1, parts: { OH: 'fire/OH.geojson', XX: '../../etc/passwd' } },
    { id: 'nc', label: 'NC', kind: 'points', part_by: null, source: 'x', license: 'non_commercial', features: 1, parts: { all: 'fire/OH.geojson' } },
  ] }));
  return dir;
}

test('datasets: listed with licence, served by part, gated by licence, never outside the data dir', async () => {
  const ds = createDatasets({ dir: dataDir(), env: {} });
  assert.deepEqual(ds.list().map((d) => [d.id, d.available]), [['fire', true], ['nc', false]]);
  assert.ok(ds.part('fire', 'oh').size > 10, 'state part, case-insensitive');
  assert.throws(() => ds.part('fire', 'CA'), (e) => e.status === 404);
  assert.throws(() => ds.part('fire', 'XX'), (e) => e.status === 404, 'a path escaping the data dir is refused');
  assert.throws(() => ds.part('nc', 'all'), (e) => e.status === 451);
  assert.throws(() => ds.get('nope'), (e) => e.status === 404);
  assert.deepEqual(createDatasets({ dir: '/nonexistent', env: {} }).list(), []);
});

test('datasets over HTTP and MCP', async () => {
  const env = {};
  const service = createService({ fetch: stubFetch([]), env, now: () => NOW });
  const srv = createServer({ service, env, log: { error() {} }, datasets: createDatasets({ dir: dataDir(), env }) }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const list = await (await fetch(`${base}/v1/datasets`)).json();
    assert.equal(list.datasets.length, 2);
    const part = await fetch(`${base}/v1/datasets/fire/OH`);
    assert.equal(part.status, 200);
    assert.match(part.headers.get('content-type'), /geo\+json/);
    assert.equal((await part.json()).features.length, 1);
    assert.equal((await fetch(`${base}/v1/datasets/nc/all`)).status, 451);
    assert.equal((await fetch(`${base}/v1/datasets/fire/%2e%2e%2fsecret.txt`)).status, 404);
    const call = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_dataset_part', arguments: { id: 'fire', part: 'OH' } } });
    assert.match(JSON.parse(call.result.content[0].text).url, /\/v1\/datasets\/fire\/OH$/);
  } finally { srv.close(); }
});
