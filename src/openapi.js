/** OpenAPI 3.1 description of the REST surface. Kept beside the server; a test checks every route is in it. */

import { LICENSES } from './contract.js';
import { LAYERS } from './service.js';

const qp = (name, description, extra = {}) => ({ name, in: 'query', required: false, description, schema: { type: 'string', ...extra } });

const placeParams = [
  qp('place', 'Comma-separated catalogue place ids.'),
  qp('tag', 'Catalogue places with this tag.'),
  qp('lat', 'Ad-hoc point latitude (with lng).'),
  qp('lng', 'Ad-hoc point longitude (with lat).'),
  qp('coops', 'NOAA CO-OPS station id(s).'),
  qp('usgs', 'USGS monitoring location id(s).'),
  qp('ebird', 'eBird region code(s).'),
];

const Reading = {
  type: 'object',
  required: ['id', 'at', 'metric', 'value', 'summary', 'source'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string', description: 'Observation date or datetime (ISO).' },
    metric: { type: 'string' },
    value: { type: ['number', 'null'], description: 'null = reported without a number, never zero.' },
    unit: { type: ['string', 'null'] },
    summary: { type: 'string' },
    place: { type: ['object', 'null'], properties: { id: { type: 'string' }, name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, state: { type: 'string' } } },
    forecast: { type: 'boolean' },
    fields: { type: 'object' },
    source: { type: 'object', required: ['id', 'name', 'fetched_at', 'license'], properties: {
      id: { type: 'string' }, name: { type: 'string' }, url: { type: ['string', 'null'] }, fetched_at: { type: 'string' }, license: { type: 'string', enum: LICENSES },
    } },
  },
};

const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const errors = {
  400: { description: 'Bad parameter' },
  404: { description: 'Unknown source, place or layer' },
  429: { description: 'Rate limited' },
  451: { description: 'Source licence does not allow this server to republish it' },
  502: { description: 'Upstream failed' },
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'open-signals',
    version: '0.1.0',
    description: 'Public data signals with provenance and licence on every reading. Read-only. The same data is available over MCP at /mcp.',
    license: { name: 'Apache-2.0 (code); each source keeps its own data licence', identifier: 'Apache-2.0' },
  },
  paths: {
    '/v1/sources': { get: { summary: 'Search the source catalogue', parameters: [qp('query', 'Free text'), qp('topic', 'One topic'), qp('license', 'One licence', { enum: LICENSES }), qp('fetchable', 'true | false')], responses: { 200: json({ type: 'object' }) } } },
    '/v1/sources/{id}': { get: { summary: 'One catalogue entry', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), 404: errors[404] } } },
    '/v1/hubs': { get: { summary: 'Projects and catalogues that collect sources', responses: { 200: json({ type: 'object' }) } } },
    '/v1/places': { get: { summary: 'Named places as GeoJSON', parameters: [qp('tag', 'Only places with this tag')], responses: { 200: json({ type: 'object' }) } } },
    '/v1/readings': {
      get: {
        summary: 'Current readings from one source',
        parameters: [
          { ...qp('source', 'Source id with a fetcher'), required: true }, ...placeParams,
          qp('metric', 'Only this metric'), qp('since', 'ISO date or datetime'), qp('forecast', 'false drops forecasts'),
          qp('state', 'epa-echo: two-letter US state'), qp('bbox', 'noaa-nwps: xmin,ymin,xmax,ymax'), qp('elevated', 'usgs-volcanoes: true | false'),
          qp('window', 'usgs-earthquakes: hour | day | week'), qp('min', 'usgs-earthquakes: all | 1.0 | 2.5 | 4.5 | significant'), qp('limit', '1-1000, default 100'),
        ],
        responses: { 200: json({ type: 'object', properties: { source: { type: 'string' }, status: { type: 'string', enum: ['ok', 'off_season', 'not_configured'] }, detail: { type: 'string' }, generated_at: { type: 'string' }, count: { type: 'integer' }, readings: { type: 'array', items: Reading } } }), ...errors },
      },
    },
    '/v1/layers': { get: { summary: 'Layer catalogue', responses: { 200: json({ type: 'object' }) } } },
    '/v1/layers/{id}': {
      get: {
        summary: 'One layer as GeoJSON',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', enum: Object.keys(LAYERS) } }, qp('date', 'YYYY-MM-DD'), ...placeParams, qp('window', 'event layers'), qp('min', 'event layers'), qp('state', 'epa_facilities'), qp('bbox', 'flood_gauges'), qp('elevated', 'volcanoes'), qp('indicator', 'world_bank, eu_industrial_production'), qp('country', 'power_plants (ISO alpha-3)'), qp('fuel', 'power_plants'), qp('min_mw', 'power_plants')],
        responses: { 200: { description: 'GeoJSON FeatureCollection', content: { 'application/geo+json': { schema: { type: 'object' } } } }, ...errors },
      },
    },
    '/v1/zip/{zip}': { get: { summary: 'Centre of a US ZIP code area (Census ZCTA)', parameters: [{ name: 'zip', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), 404: errors[404] } } },
    '/v1/datasets': { get: { summary: 'Static public datasets', responses: { 200: json({ type: 'object' }) } } },
    '/v1/datasets/{id}': { get: { summary: 'One dataset described', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }), 404: errors[404] } } },
    '/v1/datasets/{id}/{part}': { get: { summary: 'One part of a dataset as GeoJSON (a state, or all)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'part', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'GeoJSON FeatureCollection', content: { 'application/geo+json': { schema: { type: 'object' } } } }, 404: errors[404], 451: errors[451] } } },
    '/mcp': { post: { summary: 'MCP (JSON-RPC 2.0, streamable HTTP, stateless)', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: json({ type: 'object' }) } } },
    '/health': { get: { summary: 'Liveness', responses: { 200: json({ type: 'object' }) } } },
  },
};
