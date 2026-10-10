/**
 * HTTP server: REST under /v1, MCP at /mcp, OpenAPI at /openapi.json.
 * No dependencies beyond Node 20+. Read-only, CORS open, per-IP rate limit.
 *
 *   PORT                       default 3290
 *   OPEN_SIGNALS_NONCOMMERCIAL 1 = this deployment is non-commercial, so it may
 *                              republish non-commercial sources (Open-Meteo, eBird)
 *   RATE_LIMIT_PER_MIN         per client IP, default 60
 *   TRUST_PROXY                1 = take the client IP from X-Forwarded-For
 *   NASS_API_KEY, EBIRD_API_KEY  upstream keys, if you want those sources
 *   OPEN_SIGNALS_DATA_DIR      folder with index.json of static datasets (optional; see src/datasets.js)
 */

import http from 'node:http';
import { SOURCES, HUBS, PLACES, searchSources, topics } from './catalog.js';
import { createService } from './service.js';
import { HttpError } from './errors.js';
import { handleRpc, MCP_DESCRIPTION } from './mcp.js';
import { openapi } from './openapi.js';
import { createDatasets } from './datasets.js';
import { zipCentroid } from './fetchers/zip.js';

const MAX_BODY = 1_000_000;

export function createServer({ service = createService(), env = process.env, log = console, datasets = createDatasets({ env }) } = {}) {
  const limit = Number(env.RATE_LIMIT_PER_MIN || 60);
  const hits = new Map();

  function rateLimited(ip) {
    const minute = Math.floor(Date.now() / 60_000);
    const h = hits.get(ip);
    if (!h || h.minute !== minute) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { minute, n: 1 });
      return false;
    }
    return ++h.n > limit;
  }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body, null, 2));
  };

  async function route(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p === '/mcp') {
      if (req.method === 'GET') return send(res, 200, MCP_DESCRIPTION);
      if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
      let msg;
      try { msg = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => handleRpc(service, m, datasets)))).filter(Boolean);
        return out.length ? send(res, 200, out, { 'Cache-Control': 'no-store' }) : (res.writeHead(202), res.end());
      }
      const out = await handleRpc(service, msg, datasets);
      return out ? send(res, 200, out, { 'Cache-Control': 'no-store' }) : (res.writeHead(202), res.end());
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });

    if (p === '/') {
      return send(res, 200, {
        name: 'open-signals',
        about: 'Public data signals with provenance and licence on every reading, as REST, MCP and GeoJSON.',
        catalogue: { sources: SOURCES.length, fetchable: service.fetchableIds('serve').length, hubs: HUBS.length, places: PLACES.length, datasets: datasets.list().length },
        endpoints: ['/v1/sources', '/v1/sources/{id}', '/v1/hubs', '/v1/places', '/v1/readings?source={id}', '/v1/layers', '/v1/layers/{id}', '/v1/datasets', '/v1/datasets/{id}/{part}', '/mcp', '/openapi.json', '/health'],
        repository: 'https://github.com/Civops-Platform/open-signals',
        terms: 'Provided as is, no warranty. Readings pass on upstream data as published; each carries its own licence. Not for navigation or safety decisions.',
      });
    }
    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/openapi.json') return send(res, 200, openapi);
    if (p === '/v1/sources') {
      const list = searchSources(q).map((s) => ({ ...s, servable_here: service.fetchableIds('serve').includes(s.id) }));
      return send(res, 200, { count: list.length, topics: topics(), sources: list });
    }
    if (p.startsWith('/v1/sources/')) {
      const s = SOURCES.find((x) => x.id === decodeURIComponent(p.slice(12)));
      return s ? send(res, 200, { ...s, servable_here: service.fetchableIds('serve').includes(s.id) }) : send(res, 404, { error: 'unknown source' });
    }
    if (p === '/v1/hubs') return send(res, 200, { hubs: HUBS });
    if (p.startsWith('/v1/zip/')) {
      const z = decodeURIComponent(p.slice(8));
      const c = zipCentroid(z);
      return c ? send(res, 200, { zip: z.slice(0, 5), lng: c[0], lat: c[1], source: 'US Census Bureau ZCTA gazetteer (centre of the ZIP area)' }) : send(res, 404, { error: 'unknown US ZIP code' });
    }
    if (p === '/v1/places') {
      const ps = q.tag ? PLACES.filter((x) => x.tags?.includes(q.tag)) : PLACES;
      return send(res, 200, { type: 'FeatureCollection', features: ps.map((x) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lng, x.lat] }, properties: { id: x.id, name: x.name, kind: x.kind, state: x.state, tags: x.tags, refs: x.refs } })) });
    }
    if (p === '/v1/readings') {
      if (!q.source) return send(res, 400, { error: 'source is required', fetchable: service.fetchableIds('serve') });
      return send(res, 200, await service.readings(q.source, q, { mode: 'serve' }));
    }
    if (p === '/v1/layers') return send(res, 200, { layers: service.layerCatalog('serve') });
    if (p === '/v1/datasets') return send(res, 200, { datasets: datasets.list() });
    if (p.startsWith('/v1/datasets/')) {
      const [id, part] = p.slice(13).split('/').map(decodeURIComponent);
      if (!part) return send(res, 200, datasets.get(id));
      const { file, size } = datasets.part(id, part);
      res.writeHead(200, { 'Content-Type': 'application/geo+json; charset=utf-8', 'Content-Length': size, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
      return datasets.stream(file).pipe(res);
    }
    if (p.startsWith('/v1/layers/')) return send(res, 200, await service.layer(decodeURIComponent(p.slice(11)), q, { mode: 'serve' }), { 'Content-Type': 'application/geo+json; charset=utf-8' });

    return send(res, 404, { error: 'not found' });
  }

  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Mcp-Protocol-Version' });
      return res.end();
    }
    const ip = (env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return send(res, 429, { error: 'rate limit' }, { 'Retry-After': '60' });
    const url = new URL(req.url, 'http://localhost');
    try {
      await route(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      log.error(`[open-signals] ${url.pathname}:`, e.message);
      send(res, 502, { error: `upstream failed: ${e.message}` });
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3290);
  createServer().listen(port, () => console.log(`[open-signals] listening on :${port}`));
}
