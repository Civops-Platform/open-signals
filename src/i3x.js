/**
 * CESMII i3X 1.0, read-only, over the same layers REST and MCP serve. Mounted at /i3x/v1.
 *
 * ADDRESS SPACE (derived, never authored):
 *   os:root                      the open-signals folder
 *   os:folder:<layer>            one folder per layer this server republishes (licence gate applies)
 *   os:<layer>:<place>           one object per place or event in the layer; its value is the latest
 *                                observed reading, its history every reading held for that place
 * Object types: a folder type, and one type per layer, whose schema is the reading as served
 * (value, unit, summary, observedAt, place, source with licence). Relationships: HasParent and
 * HasChildren. Nothing is written here, so update capabilities are false and a PUT answers 501.
 *
 * AUTH: off unless I3X_TOKENS is set ({"<token>": {"label": "...", "expires": "<RFC 3339>"}}); the
 * public deployment publishes one free read-only token. GET /info is open, as the spec requires.
 *
 * The space is rebuilt from the service's caches at most every REFRESH_MS; subscriptions see a
 * change when a rebuild brings a new value.
 */

import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { LAYERS } from './service.js';
import { servable } from './contract.js';
import { source as catalogSource } from './catalog.js';

export const I3X_SPEC_VERSION = '1.0';
const I3X_NS = { uri: 'https://cesmii.org/i3x', displayName: 'i3X' };
const NS = { uri: 'https://open-signals.civops.io/ns', displayName: 'open-signals' };
const REFRESH_MS = 10 * 60_000;
const MAX_SUBS = 256, MAX_BATCHES = 1000, MAX_BODY = 1 << 20;

// The layers published over i3X and the query each is built with (the REST defaults).
export const I3X_LAYERS = {
  earthquakes: { q: { window: 'day' } },
  volcanoes: {},
  natural_events: {},
  flood_gauges: {},
  water_level: {},
  river_flow: {},
  ice: {},
  recalls: {},
  contract_awards: {},
  wildlife: {},
  world_bank: { q: { indicator: 'gdp_growth' } },
  earthquakes_emsc: { q: { window: 'day' } },
  tropical_cyclones: {},
  power_plants: { q: { min_mw: 2000 } },
  eu_industrial_production: { q: { indicator: 'industrial_production' } },
  fema_declarations: {},
};

const utc = (d) => new Date(d).toISOString().replace(/\.000Z$/, 'Z');
const isRfc3339 = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(s) && !Number.isNaN(Date.parse(s));
const stamp = (at) => { const s = /^\d{4}-\d{2}-\d{2}$/.test(at || '') ? `${at}T00:00:00Z` : at; const t = Date.parse(s); return Number.isNaN(t) ? null : utc(t); };
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const problem = (status, title, detail) => ({ success: false, responseDetail: { title, status, detail } });
const TITLES = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 413: 'Payload Too Large', 429: 'Too Many Requests', 501: 'Not Implemented' };
const itemErr = (key, id, status, detail) => ({ success: false, [key]: id, responseDetail: { title: TITLES[status] || 'Error', status, detail } });
const bulk = (results) => ({ success: results.every((r) => r.success), results });

const READING_SCHEMA = (unit) => ({
  type: 'object',
  properties: {
    value: { type: ['number', 'null'], description: `The reading${unit ? ` in ${unit}` : ''}; null when the source reported none (never zero)` },
    unit: { type: ['string', 'null'] },
    summary: { type: 'string' },
    observedAt: { type: 'string', description: 'When the source observed it (RFC 3339)' },
    forecast: { type: 'boolean' },
    place: { type: ['object', 'null'], description: 'Where it was observed; null for a series with no place (a national index, a company)', properties: { id: { type: 'string' }, name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } } },
    source: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, url: { type: ['string', 'null'] }, fetchedAt: { type: 'string' }, license: { type: 'string' } } },
    fields: { type: 'object', description: 'Everything else the upstream said' },
  },
  required: ['value', 'summary', 'observedAt', 'source'],
});

/**
 * folders(): Promise<[{ id, label, description, read?, unit?, license?, sourceName?, readings: [reading] }]>
 *   is the whole address space below the root, one folder per series; open-signals passes its
 *   published layers (openSignalsFolders below), and any other server can pass its own (Genome does).
 * ns: { uri, displayName }, serverName, serverVersion, rootName, rootDescription, prefix (elementId prefix).
 */
/** open-signals' published layers as i3X folders (the licence gate applies). */
export async function openSignalsFolders(service, env = process.env) {
  const out = [];
  for (const [id, cfg] of Object.entries(I3X_LAYERS)) {
    const L = LAYERS[id];
    if (!L) continue;
    const src = catalogSource(L.source);
    if (!servable(src.license, env)) continue;
    let r;
    try { r = await service.readings(L.source, { ...(cfg.q || {}), limit: 1000 }, { mode: 'serve' }); } catch { continue; }
    out.push({ id, label: L.label, read: L.read, unit: L.unit, license: src.license, sourceName: src.name, description: `${src.name} (${src.license})`,
      readings: r.readings.filter((x) => !L.metric || x.metric === L.metric) });
  }
  return out;
}

export function createI3x({ service, folders, ns = NS, serverName = 'open-signals', serverVersion = '0.1.0', prefix = 'os',
  rootName = 'open-signals', rootDescription = 'Public data signals with provenance and licence on every reading', authHint = 'The public read-only token is published in the open-signals README.',
  env = process.env, now = () => Date.now(), warm = false } = {}) {
  const loadFolders = folders || (() => openSignalsFolders(service, env));
  const boot = utc(now());
  let space = null, builtAt = 0, building = null;
  const subs = new Map();
  const buckets = new Map();

  function tokens() {
    const raw = env.I3X_TOKENS;
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      const m = new Map(Object.entries(t).map(([k, v]) => [k, { label: String(v?.label || 'unnamed'), expires: v?.expires ?? null }]));
      return m.size ? m : null;
    } catch { return null; }
  }

  async function build() {
    const P = prefix;
    const types = [
      { elementId: `${P}:type:folder`, displayName: 'Folder', namespaceUri: ns.uri, sourceTypeId: 'Folder', version: '1.0.0',
        schema: { type: 'object', description: 'A folder. It has no value of its own.', properties: {} } },
    ];
    const rels = [['HasParent', 'HasChildren'], ['HasChildren', 'HasParent']]
      .map(([id, rev]) => ({ elementId: id, displayName: id, namespaceUri: I3X_NS.uri, relationshipId: id, reverseOf: rev }));
    const objects = [], values = new Map(), history = new Map(), edges = new Map();
    const edge = (a, rel, b) => { let m = edges.get(a); if (!m) edges.set(a, m = {}); (m[rel] ??= []).push(b); };
    const root = `${P}:root`;
    objects.push({ elementId: root, displayName: rootName, typeElementId: `${P}:type:folder`, parentId: null, isComposition: false, isExtended: false, description: rootDescription });
    values.set(root, { value: null, quality: 'GoodNoData', timestamp: boot });

    for (const f of await loadFolders()) {
      const typeId = `${P}:type:${f.id}`;
      types.push({ elementId: typeId, displayName: f.label, namespaceUri: ns.uri, sourceTypeId: f.id, version: '1.0.0',
        schema: { ...READING_SCHEMA(f.unit), description: `${f.label}. ${f.read || ''} Source: ${f.sourceName || ''}${f.license ? `, licence ${f.license}` : ''}.`.replace(/\s+/g, ' ').trim() } });
      const folder = `${P}:folder:${f.id}`;
      objects.push({ elementId: folder, displayName: f.label, typeElementId: `${P}:type:folder`, parentId: root, isComposition: false, isExtended: false,
        description: f.description || f.label });
      values.set(folder, { value: null, quality: 'GoodNoData', timestamp: boot });
      edge(root, 'HasChildren', folder); edge(folder, 'HasParent', root);
      const byPlace = new Map();
      for (const x of f.readings) {
        const pid = x.place?.id || x.id;
        (byPlace.get(pid) || byPlace.set(pid, []).get(pid)).push(x);
      }
      for (const [pid, rs] of byPlace) {
        const oid = `${P}:${f.id}:${slug(pid)}`;
        if (values.has(oid)) continue;
        const vqts = rs.map((x) => {
          const ts = stamp(x.at);
          // The VQT value is the whole reading, which is always present, so quality is Good even when the
          // reading's own number is null (QRY-02: GoodNoData would claim the value itself is null).
          return ts && { quality: 'Good', timestamp: ts, forecast: !!x.forecast,
            value: { value: x.value ?? null, unit: x.unit ?? null, summary: x.summary, observedAt: ts, ...(x.forecast ? { forecast: true } : {}), place: x.place ?? null,
              source: { id: x.source.id, name: x.source.name, url: x.source.url ?? null, fetchedAt: x.source.fetched_at, license: x.source.license }, fields: x.fields ?? {} } };
        }).filter(Boolean).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        if (!vqts.length) continue;
        const observed = vqts.filter((v) => !v.forecast);
        const pool = observed.length ? observed : vqts;
        const strip = ({ forecast, ...v }) => v;
        objects.push({ elementId: oid, displayName: String(rs[0].place?.name || rs[0].summary).slice(0, 160), typeElementId: typeId, parentId: folder,
          isComposition: false, isExtended: false, description: String(rs[0].summary).slice(0, 240) });
        values.set(oid, strip(pool[pool.length - 1]));
        history.set(oid, observed.map(strip));
        edge(folder, 'HasChildren', oid); edge(oid, 'HasParent', folder);
      }
    }
    return { namespaces: [ns, I3X_NS], types, typesById: new Map(types.map((t) => [t.elementId, t])), rels, relsById: new Map(rels.map((x) => [x.elementId, x])),
      objects, byId: new Map(objects.map((o) => [o.elementId, o])), values, history, edges };
  }

  async function as() {
    if (space && now() - builtAt < REFRESH_MS) return space;
    building ??= build().then((s) => { space = s; builtAt = now(); return s; }).finally(() => { building = null; });
    if (space) return space; // serve the last space while a fresh one builds
    return building;
  }

  const objResponse = (a, o, meta) => {
    const base = { elementId: o.elementId, displayName: o.displayName, typeElementId: o.typeElementId, parentId: o.parentId, isComposition: o.isComposition, isExtended: o.isExtended };
    if (meta) {
      const t = a.typesById.get(o.typeElementId);
      base.metadata = { description: o.description ?? null, typeNamespaceUri: t ? t.namespaceUri : ns.uri, sourceTypeId: t ? t.sourceTypeId : 'Folder', relationships: a.edges.get(o.elementId) ?? {} };
    }
    return base;
  };
  const vqt = (a, id) => { const v = a.values.get(id); return v ? { value: v.value, quality: v.quality, timestamp: v.timestamp } : null; };

  function stage(sub, a) {
    const updates = [];
    for (const id of sub.monitored.keys()) {
      const v = vqt(a, id);
      const fp = v ? JSON.stringify(v) : 'gone';
      if (sub.seen.get(id) === fp) continue;
      sub.seen.set(id, fp);
      if (v) updates.push({ elementId: id, ...v });
    }
    if (!updates.length) return null;
    const batch = { sequenceNumber: sub.nextSeq++, updates };
    sub.batches.push(batch);
    if (sub.batches.length > MAX_BATCHES) sub.batches.splice(0, sub.batches.length - MAX_BATCHES);
    return batch;
  }
  let ticker = null;
  function tick() {
    const open = [...subs.values()].some((s) => s.stream);
    if (open && !ticker) {
      ticker = setInterval(async () => { const a = await as(); for (const s of subs.values()) if (s.stream) { const b = stage(s, a); if (b) s.stream.send(b.updates); } }, 5000);
      ticker.unref?.();
    }
    if (!open && ticker) { clearInterval(ticker); ticker = null; }
  }

  function rateOk(key) {
    const perSec = Number(env.I3X_RATE_PER_SECOND ?? 25), burst = Number(env.I3X_RATE_BURST ?? 120), t = now() / 1000;
    const [tok, last] = buckets.get(key) ?? [burst, t];
    const have = Math.min(burst, tok + (t - last) * perSec);
    if (have < 1) { buckets.set(key, [have, t]); return { ok: false, retry: Math.max(1, Math.ceil((1 - have) / perSec)) }; }
    buckets.set(key, [have - 1, t]);
    return { ok: true };
  }

  const need = (b, k) => Array.isArray(b?.[k]);
  async function route(method, path, url, body, principal) {
    const R = (status, obj) => ({ status, obj });
    const key = `${method} ${path}`;
    switch (key) {
      case 'GET /info':
        return R(200, { success: true, result: { specVersion: I3X_SPEC_VERSION, serverVersion, serverName,
          capabilities: { query: { history: true }, update: { current: false, history: false }, subscribe: { stream: true } } } });
      case 'GET /namespaces': return R(200, { success: true, result: [ns, I3X_NS] }); // fixed; never waits on a build
      case 'GET /objecttypes': { const ns = url.searchParams.get('namespaceUri'); return R(200, { success: true, result: (await as()).types.filter((t) => !ns || t.namespaceUri === ns) }); }
      case 'GET /relationshiptypes': { const ns = url.searchParams.get('namespaceUri'); return R(200, { success: true, result: (await as()).rels.filter((t) => !ns || t.namespaceUri === ns) }); }
      case 'GET /objects': {
        const a = await as(); const typeId = url.searchParams.get('typeElementId'); const root = url.searchParams.get('root') === 'true'; const meta = url.searchParams.get('includeMetadata') === 'true';
        return R(200, { success: true, result: a.objects.filter((o) => (!typeId || o.typeElementId === typeId) && (!root || o.parentId === null)).map((o) => objResponse(a, o, meta)) });
      }
    }
    if (method !== 'POST') return null;
    const b = body;
    if (b && b.__tooBig) return R(413, problem(413, 'Payload Too Large', `Request bodies are limited to ${MAX_BODY} bytes`));
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return R(400, problem(400, 'Bad Request', 'The request body must be a JSON object'));
    const a = await as();
    switch (key) {
      case 'POST /objecttypes/query': case 'POST /relationshiptypes/query': {
        if (!need(b, 'elementIds')) return R(400, problem(400, 'Bad Request', 'elementIds array is required'));
        const map = key.startsWith('POST /objecttypes') ? a.typesById : a.relsById;
        return R(200, bulk(b.elementIds.map((id) => map.has(id) ? { success: true, elementId: id, result: map.get(id) } : itemErr('elementId', String(id), 404, `Not found: ${id}`))));
      }
      case 'POST /objects/list': {
        if (!need(b, 'elementIds')) return R(400, problem(400, 'Bad Request', 'elementIds array is required'));
        return R(200, bulk(b.elementIds.map((id) => a.byId.has(id) ? { success: true, elementId: id, result: objResponse(a, a.byId.get(id), b.includeMetadata === true) } : itemErr('elementId', String(id), 404, `Element not found: ${id}`))));
      }
      case 'POST /objects/related': {
        if (!need(b, 'elementIds')) return R(400, problem(400, 'Bad Request', 'elementIds array is required'));
        return R(200, bulk(b.elementIds.map((id) => {
          if (!a.byId.has(id)) return itemErr('elementId', String(id), 404, `Element not found: ${id}`);
          const out = [];
          for (const [rel, targets] of Object.entries(a.edges.get(id) ?? {})) {
            if (b.relationshipType && rel !== b.relationshipType) continue;
            for (const t of targets) if (a.byId.has(t)) out.push({ sourceRelationship: rel, object: objResponse(a, a.byId.get(t), b.includeMetadata === true) });
          }
          return { success: true, elementId: id, result: out };
        })));
      }
      case 'POST /objects/value': {
        if (!need(b, 'elementIds')) return R(400, problem(400, 'Bad Request', 'elementIds array is required'));
        const depth = b.maxDepth === undefined ? 1 : b.maxDepth;
        if (!Number.isInteger(depth) || depth < 0) return R(400, problem(400, 'Bad Request', 'maxDepth must be a non-negative integer'));
        return R(200, bulk(b.elementIds.map((id) => {
          const o = a.byId.get(id), v = o && vqt(a, id);
          return o && v ? { success: true, elementId: id, result: { isComposition: o.isComposition, ...v } } : itemErr('elementId', String(id), 404, `Element not found: ${id}`);
        })));
      }
      case 'POST /objects/history': {
        if (!need(b, 'elementIds')) return R(400, problem(400, 'Bad Request', 'elementIds array is required'));
        if (!b.startTime || !b.endTime) return R(400, problem(400, 'Bad Request', 'startTime and endTime are required'));
        if (!isRfc3339(b.startTime) || !isRfc3339(b.endTime)) return R(400, problem(400, 'Bad Request', 'startTime and endTime must be RFC 3339 timestamps'));
        const depth = b.maxDepth === undefined ? 1 : b.maxDepth;
        if (!Number.isInteger(depth) || depth < 0) return R(400, problem(400, 'Bad Request', 'maxDepth must be a non-negative integer'));
        const lo = Math.min(Date.parse(b.startTime), Date.parse(b.endTime)), hi = Math.max(Date.parse(b.startTime), Date.parse(b.endTime));
        return R(200, bulk(b.elementIds.map((id) => {
          const o = a.byId.get(id);
          if (!o) return itemErr('elementId', String(id), 404, `Element not found: ${id}`);
          const values = (a.history.get(id) ?? []).filter((p) => { const t = Date.parse(p.timestamp); return t >= lo && t <= hi; });
          return { success: true, elementId: id, result: { isComposition: o.isComposition, values } };
        })));
      }
    }
    if (key.startsWith('POST /subscriptions')) return subscriptions(key, b, principal, a);
    return null;
  }

  function subscriptions(key, b, principal, a) {
    const R = (status, obj) => ({ status, obj });
    if (!(typeof b.clientId === 'string' && b.clientId)) return R(400, problem(400, 'Bad Request', 'clientId is required'));
    const owned = (id) => { const s = subs.get(id); return s && s.clientId === b.clientId && s.owner === principal.label ? s : null; };
    const notFound = (id) => R(404, problem(404, 'Not Found', `Subscription not found: ${id}`));
    switch (key) {
      case 'POST /subscriptions': {
        if (subs.size >= MAX_SUBS) {
          const idle = [...subs.values()].find((s) => !s.stream);
          if (!idle) return R(400, problem(400, 'Bad Request', 'This server holds its maximum number of subscriptions'));
          subs.delete(idle.subscriptionId);
        }
        const subscriptionId = randomBytes(24).toString('base64url');
        const displayName = typeof b.displayName === 'string' ? b.displayName : null;
        subs.set(subscriptionId, { subscriptionId, clientId: b.clientId, owner: principal.label, displayName, monitored: new Map(), seen: new Map(), batches: [], nextSeq: 1, stream: null });
        return R(200, { success: true, result: { clientId: b.clientId, subscriptionId, displayName } });
      }
      case 'POST /subscriptions/list': case 'POST /subscriptions/delete': {
        if (!need(b, 'subscriptionIds')) return R(400, problem(400, 'Bad Request', 'subscriptionIds array is required'));
        return R(200, bulk(b.subscriptionIds.map((id) => {
          const s = owned(id);
          if (!s) return itemErr('subscriptionId', String(id), 404, `Subscription not found: ${id}`);
          if (key.endsWith('/delete')) { s.stream?.close(); subs.delete(id); tick(); return { success: true, subscriptionId: id, result: null }; }
          return { success: true, subscriptionId: id, result: { subscriptionId: id, displayName: s.displayName, monitoredObjects: [...s.monitored].map(([elementId, maxDepth]) => ({ elementId, maxDepth })) } };
        })));
      }
      case 'POST /subscriptions/register': case 'POST /subscriptions/unregister': {
        if (!b.subscriptionId || !need(b, 'elementIds')) return R(400, problem(400, 'Bad Request', 'subscriptionId and elementIds are required'));
        const s = owned(b.subscriptionId); if (!s) return notFound(b.subscriptionId);
        const depth = b.maxDepth === undefined ? 1 : b.maxDepth;
        if (!Number.isInteger(depth) || depth < 0) return R(400, problem(400, 'Bad Request', 'maxDepth must be a non-negative integer'));
        const results = b.elementIds.map((id) => {
          if (key.endsWith('/unregister')) {
            if (!s.monitored.has(id)) return itemErr('elementId', String(id), 404, `Element not registered: ${id}`);
            s.monitored.delete(id); s.seen.delete(id); return { success: true, elementId: id, result: null };
          }
          if (!a.byId.has(id)) return itemErr('elementId', String(id), 404, `Element not found: ${id}`);
          if (!s.monitored.has(id)) s.monitored.set(id, depth);
          return { success: true, elementId: id, result: null };
        });
        if (key.endsWith('/register')) { const batch = stage(s, a); if (batch && s.stream) s.stream.send(batch.updates); }
        return R(200, bulk(results));
      }
      case 'POST /subscriptions/sync': {
        if (!b.subscriptionId) return R(400, problem(400, 'Bad Request', 'subscriptionId is required'));
        const s = owned(b.subscriptionId); if (!s) return notFound(b.subscriptionId);
        if (s.stream) return R(400, problem(400, 'Bad Request', 'This subscription has an open stream; close it before calling sync'));
        const last = b.lastSequenceNumber;
        if (last === -1) s.batches = [];
        else if (Number.isInteger(last) && last >= 0) s.batches = s.batches.filter((x) => x.sequenceNumber > last);
        stage(s, a);
        return R(200, { success: true, result: s.batches });
      }
      case 'POST /subscriptions/stream': {
        if (!b.subscriptionId) return R(400, problem(400, 'Bad Request', 'subscriptionId is required'));
        const s = owned(b.subscriptionId); if (!s) return notFound(b.subscriptionId);
        return { stream: s };
      }
    }
    return null;
  }

  function send(res, status, obj, gz, extra = {}) {
    const text = JSON.stringify(obj);
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...extra };
    if (gz) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; res.writeHead(status, headers); return res.end(gzipSync(text)); }
    res.writeHead(status, headers); res.end(text);
  }

  /** Node handler for paths under mount; returns false when the path is not ours. */
  async function handle(req, res, url, rawBody, mount = '/i3x/v1') {
    let path = url.pathname.replace(/\/+$/, '');
    if (path !== mount && !path.startsWith(mount + '/')) return false;
    path = path === mount ? '/' : path.slice(mount.length);
    const method = req.method.toUpperCase();
    const gz = /\bgzip\b/i.test(req.headers['accept-encoding'] || '');
    const table = tokens();
    if (!table) { send(res, 404, problem(404, 'Not Found', 'The i3X endpoint is not enabled on this deployment.'), gz); return true; }
    if (method === 'OPTIONS') { res.writeHead(204, { Allow: 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' }); res.end(); return true; }
    let principal = { label: 'anonymous' };
    if (!(method === 'GET' && path === '/info')) {
      const h = req.headers.authorization || '';
      const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      const p = tok ? table.get(tok) : null;
      if (!p) { send(res, 401, problem(401, 'Unauthorized', 'A bearer token is required. ' + authHint), gz, { 'WWW-Authenticate': 'Bearer realm="i3x"' }); return true; }
      if (p.expires && (Number.isNaN(Date.parse(p.expires)) || now() >= Date.parse(p.expires))) { send(res, 401, problem(401, 'Unauthorized', 'This credential has expired.'), gz, { 'WWW-Authenticate': 'Bearer realm="i3x", error="invalid_token"' }); return true; }
      const rl = rateOk(tok);
      if (!rl.ok) { send(res, 429, problem(429, 'Too Many Requests', 'This credential is over its request budget.'), gz, { 'Retry-After': String(rl.retry) }); return true; }
      if (method === 'PUT' && (path === '/objects/value' || path === '/objects/history')) { send(res, 501, problem(501, 'Not Implemented', 'Nothing on this server is writable; update capabilities are false in GET /info.'), gz); return true; }
      principal = p;
    }
    let body = null;
    if (method === 'POST') {
      if (rawBody.length > MAX_BODY) body = { __tooBig: true };
      else { try { body = JSON.parse(rawBody || '{}'); } catch { body = null; } }
    }
    try {
      const out = await route(method, path, url, body, principal);
      if (!out) { send(res, 404, problem(404, 'Not Found', `No such i3X endpoint: ${method} ${mount}${path}`), gz); return true; }
      if (out.stream) { openStream(out.stream, res); return true; }
      send(res, out.status, out.obj, gz);
    } catch (e) {
      send(res, 500, problem(500, 'Internal Server Error', String(e?.message || e).slice(0, 200)), gz);
    }
    return true;
  }

  function openStream(s, res) {
    s.stream?.close();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
    res.write(': ok\n\n');
    const handleStream = {
      send(updates) { try { res.write(`data: ${JSON.stringify(updates)}\n\n`); } catch {} },
      close() { if (s.stream === handleStream) s.stream = null; clearInterval(beat); try { res.end(); } catch {} tick(); },
    };
    const pending = s.batches.flatMap((x) => x.updates);
    if (pending.length) handleStream.send(pending);
    const beat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15000);
    beat.unref?.();
    res.on('close', () => handleStream.close());
    s.stream = handleStream; tick();
  }

  // Build the address space now rather than on the first request: a cold build of a large space
  // (thousands of objects) ran past a client's timeout (CESMII EXP-01 on the Genome endpoint).
  if (warm) as().catch(() => {});
  return { handle, addressSpace: as };
}
