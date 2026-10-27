/**
 * MCP server: streamable HTTP transport, JSON-RPC 2.0, stateless.
 * Read-only by design: every tool reads the catalogue or a public upstream; none
 * writes, sends or stores anything. Same licence gate as REST (mode 'serve').
 *
 *   POST /mcp  {jsonrpc:"2.0", method: initialize | tools/list | tools/call |
 *               resources/list | resources/read | ping}
 *   GET  /mcp  human-readable description
 */

import { SOURCES, HUBS, PLACES, searchSources, topics } from './catalog.js';
import { LICENSES } from './contract.js';
import { HttpError, LAYERS } from './service.js';

export const PROTOCOL_VERSION = '2025-06-18';
const VERSION = '0.1.0';

const placeArgs = {
  place: { type: 'string', description: 'Comma-separated catalogue place ids (see list_places).' },
  tag: { type: 'string', description: 'Catalogue places with this tag, e.g. waterfowl, ice-fishing.' },
  lat: { type: 'number', description: 'Ad-hoc point latitude (with lng). For weather and WSI.' },
  lng: { type: 'number', description: 'Ad-hoc point longitude (with lat).' },
  coops: { type: 'string', description: 'NOAA CO-OPS station id(s), comma-separated, e.g. 9063085.' },
  usgs: { type: 'string', description: 'USGS monitoring location id(s), e.g. USGS-04193500.' },
  ebird: { type: 'string', description: 'eBird region code(s), e.g. US-OH-095.' },
};

export const TOOLS = [
  {
    name: 'search_sources',
    description: 'Search the catalogue of public data sources (weather, water, hazards, flights, ships, energy, filings, trade, ...). Each entry gives the API, coverage, cadence, auth needed and licence. Use it to find where a kind of data comes from before writing a fetcher.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Words matched against name, id, coverage, topics and licence note.' },
      topic: { type: 'string', description: 'One topic, e.g. weather, water, fires, flights, energy.' },
      license: { type: 'string', enum: LICENSES },
      fetchable: { type: 'boolean', description: 'true: only sources this server can fetch now; false: only catalogued ones.' },
    } },
  },
  { name: 'get_source', description: 'One catalogue entry in full.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list_hubs', description: 'Projects and catalogues that collect sources (God\'s Eye View, World Monitor, the MCP Registry, Source Cooperative, ...), with how each relates to this one.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_places', description: 'Named places the fetchers read for, with their upstream ids (CO-OPS station, USGS gauge, eBird region) and tags.', inputSchema: { type: 'object', properties: { tag: { type: 'string' } } } },
  {
    name: 'get_readings',
    description: 'Fetch current readings from one source, each with value, unit, a one-line summary, place and provenance (source, URL, fetch time, licence). Sources this server will not republish (non-commercial, restricted or unreviewed licence) answer with an error naming the licence.',
    inputSchema: { type: 'object', properties: {
      source: { type: 'string', description: 'A source id with a fetcher (search_sources with fetchable=true).' },
      ...placeArgs,
      metric: { type: 'string', description: 'Only readings of this metric.' },
      since: { type: 'string', description: 'ISO date or datetime; only readings at or after it.' },
      forecast: { type: 'boolean', description: 'false drops modelled future values.' },
      window: { type: 'string', description: 'usgs-earthquakes only: hour | day | week.' },
      state: { type: 'string', description: 'epa-echo only: two-letter US state, default OH.' },
      bbox: { type: 'string', description: 'noaa-nwps only: xmin,ymin,xmax,ymax in degrees (≤400 sq deg); default the Great Lakes basin.' },
      elevated: { type: 'boolean', description: 'usgs-volcanoes only: true keeps volcanoes above normal.' },
      min: { type: 'string', description: 'usgs-earthquakes only: all | 1.0 | 2.5 | 4.5 | significant.' },
      limit: { type: 'number', description: '1-1000, default 100.' },
    }, required: ['source'] },
  },
  { name: 'list_datasets', description: 'Static public datasets this server holds as GeoJSON (wildfire burn perimeters, public-land share by county, federal campgrounds, fire-weather stations), with source, licence, feature count and parts (one per state, or "all").', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_dataset_part', description: 'The URL of one part of a dataset as GeoJSON, plus its description. Fetch the URL for the features; parts can be several megabytes.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, part: { type: 'string', description: 'Two-letter state, or "all" for single-part datasets.' } }, required: ['id', 'part'] } },
  { name: 'list_layers', description: 'Map layers this server can draw as GeoJSON, with unit, source, licence, whether it is available here, and how to read it.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'get_layer',
    description: 'One map layer as a GeoJSON FeatureCollection: one point per place with the reading on the date (else the latest observed before it, never a guess), or one point per event for event layers.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', enum: Object.keys(LAYERS) }, date: { type: 'string', description: 'YYYY-MM-DD; default today (US Eastern).' }, ...placeArgs, window: { type: 'string' }, min: { type: 'string' }, state: { type: 'string' }, bbox: { type: 'string' }, elevated: { type: 'boolean' }, indicator: { type: 'string' }, country: { type: 'string', description: 'power_plants: ISO alpha-3, e.g. DEU' }, fuel: { type: 'string', description: 'power_plants: coal, oil/gas, nuclear, hydropower, wind, utility-scale solar, geothermal or bioenergy' }, min_mw: { type: 'number' }, status: { type: 'string', description: 'power_plants: operating | construction' }, erupted_since: { type: 'number', description: 'volcanoes_world: year, default 1900' }, continuing: { type: 'boolean', description: 'volcanoes_world: only eruptions in progress' }, radius: { type: 'number', description: 'aircraft, gps_interference: nautical miles around lat/lng, 1-250' } }, required: ['id'] },
  },
];

const RESOURCES = [
  { uri: 'open-signals://catalog/sources', name: 'Source catalogue', mimeType: 'application/json', description: `${SOURCES.length} public data sources with API, coverage, cadence, auth and licence.`, body: () => ({ sources: SOURCES }) },
  { uri: 'open-signals://catalog/hubs', name: 'Hubs', mimeType: 'application/json', description: 'Projects and catalogues that collect sources.', body: () => ({ hubs: HUBS }) },
  { uri: 'open-signals://catalog/places', name: 'Places', mimeType: 'application/json', description: 'Named places with upstream ids and tags.', body: () => ({ places: PLACES }) },
  { uri: 'open-signals://catalog/topics', name: 'Topics', mimeType: 'application/json', description: 'Every topic used in the catalogue.', body: () => ({ topics: topics() }) },
];

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

const PUBLIC_BASE = process.env.OPEN_SIGNALS_PUBLIC_URL || 'https://open-signals.civops.io';

async function callTool(svc, name, a = {}, ds) {
  switch (name) {
    case 'search_sources': return text({ sources: searchSources(a) });
    case 'get_source': {
      const s = SOURCES.find((x) => x.id === a.id);
      if (!s) throw new HttpError(404, `unknown source '${a.id}'`);
      return text(s);
    }
    case 'list_hubs': return text({ hubs: HUBS });
    case 'list_places': return text({ places: a.tag ? PLACES.filter((p) => p.tags?.includes(a.tag)) : PLACES });
    case 'get_readings': {
      if (!a.source) throw new HttpError(400, 'source is required');
      return text(await svc.readings(a.source, a, { mode: 'serve' }));
    }
    case 'list_layers': return text({ layers: svc.layerCatalog('serve') });
    case 'list_datasets': return text({ datasets: ds ? ds.list() : [] });
    case 'get_dataset_part': {
      if (!ds) throw new HttpError(404, 'no datasets on this server');
      const meta = ds.get(a.id); const { size } = ds.part(a.id, a.part);
      return text({ ...meta, part: a.part, bytes: size, url: `${PUBLIC_BASE}/v1/datasets/${encodeURIComponent(a.id)}/${encodeURIComponent(a.part)}` });
    }
    case 'get_layer': return text(await svc.layer(a.id, a, { mode: 'serve' }));
    default: throw Object.assign(new Error(`unknown tool '${name}'`), { rpc: -32602 });
  }
}

/** Handle one JSON-RPC message; returns the response object, or null for a notification. */
export async function handleRpc(svc, msg, ds) {
  const { id = null, method, params = {} } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'invalid request');
  if (method.startsWith('notifications/')) return null;
  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'open-signals', version: VERSION },
          instructions: 'Public data signals with provenance and licence on every reading. Start with search_sources to find where data comes from, list_layers for map-ready GeoJSON, get_readings for values. Read-only.',
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call':
        try {
          return ok(await callTool(svc, params.name, params.arguments || {}, ds));
        } catch (e) {
          if (e.rpc) return err(e.rpc, e.message);
          // Tool failures are results the model can read, not protocol errors.
          return ok({ isError: true, content: [{ type: 'text', text: e.message }] });
        }
      case 'resources/list': return ok({ resources: RESOURCES.map(({ body, ...r }) => r) });
      case 'resources/read': {
        const r = RESOURCES.find((x) => x.uri === params.uri);
        if (!r) return err(-32602, `unknown resource '${params.uri}'`);
        return ok({ contents: [{ uri: r.uri, mimeType: r.mimeType, text: JSON.stringify(r.body(), null, 2) }] });
      }
      default: return err(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}

export const MCP_DESCRIPTION = {
  name: 'open-signals MCP server',
  transport: 'streamable HTTP, JSON-RPC 2.0, stateless, no auth',
  protocolVersion: PROTOCOL_VERSION,
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  resources: RESOURCES.map((r) => r.uri),
};
