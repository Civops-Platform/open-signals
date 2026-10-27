#!/usr/bin/env node
/**
 * Live check: every fetcher against its real upstream, then the HTTP and MCP
 * surfaces on a local server. Not part of `npm test` (it needs the network).
 * A source whose key is not set must answer not_configured, not fail.
 * Exit 1 on any failure or invalid reading.
 */

import { createService } from '../src/service.js';
import { createServer } from '../src/server.js';
import { FETCHERS } from '../src/fetchers/index.js';
import { validateReading } from '../src/contract.js';

let failed = 0;
const say = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const svc = createService();

// Sources that need a query to answer at all: the default is a sensible one, not an empty one.
const LIVE_Q = { 'adsb-lol': { mode: 'military' }, 'sec-filings': { days: '7' } };

for (const id of Object.keys(FETCHERS)) {
  try {
    const r = await svc.readings(id, LIVE_Q[id] || {}, { mode: 'local' });
    const bad = r.readings.flatMap(validateReading);
    const ok = (r.status === 'ok' && r.count > 0 && !bad.length) || r.status === 'off_season' || r.status === 'not_configured';
    say(ok, `${id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}, ${r.count} readings${bad.length ? `, invalid: ${bad[0]}` : ''}${r.readings[0] ? `\n      e.g. ${r.readings[0].summary}` : ''}`);
  } catch (e) {
    say(false, `${id}: ${e.message}`);
  }
}

const srv = createServer({ env: { ...process.env, OPEN_SIGNALS_NONCOMMERCIAL: '' } }).listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
try {
  const quake = await fetch(`${base}/v1/layers/earthquakes?min=2.5`);
  const gj = await quake.json();
  say(quake.status === 200 && Array.isArray(gj.features), `GET /v1/layers/earthquakes → ${quake.status}, ${gj.features?.length} features`);
  const lvl = await fetch(`${base}/v1/layers/water_level`);
  say(lvl.status === 200, `GET /v1/layers/water_level → ${lvl.status}, ${(await lvl.json()).features?.length} features`);
  for (const id of ['volcanoes', 'flood_gauges', 'epa_facilities', 'power_plants']) {
    const r = await fetch(`${base}/v1/layers/${id}`);
    const j = await r.json();
    say(r.status === 200 && j.features?.length > 0, `GET /v1/layers/${id} → ${r.status}, ${j.features?.length} features${j.error ? ` (${j.error})` : ''}`);
  }
  for (const path of ['military_aircraft', 'gps_interference', 'fires?bbox=-125,24,-66,50', 'persistent_heat', 'steel_plant_heat', 'cement_plant_heat', 'chemical_plant_heat', 'oil_gas_field_heat', 'weather_alerts?marine=true', 'reservoirs_west', 'quake_corroboration', 'fire_corroboration', 'ships_baltic', 'data_centers?status=construction', 'aircraft?lat=41.41&lng=-81.85&radius=60']) {
    const r = await fetch(`${base}/v1/layers/${path}`);
    const j = await r.json();
    const basis = j.features?.[0]?.properties?.basis;
    say(r.status === 200 && j.features?.length > 0, `GET /v1/layers/${path} → ${r.status}, ${j.features?.length} features, basis ${basis}${j.error ? ` (${j.error})` : ''}`);
  }
  for (const id of ['river_discharge', 'air_quality', 'volcanoes_world']) {
    const r = await fetch(`${base}/v1/layers/${id}`);
    say(r.status === 451, `GET /v1/layers/${id} (public mode, non-commercial source) → ${r.status} (expected 451)`);
  }
  const gated = await fetch(`${base}/v1/readings?source=open-meteo&lat=41.5&lng=-81.7`);
  say(gated.status === 451, `GET /v1/readings?source=open-meteo (public mode) → ${gated.status} (expected 451)`);
  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_readings', arguments: { source: 'noaa-coops', coops: '8518750' } } }) });
  const body = await mcp.json();
  const parsed = body.result && !body.result.isError ? JSON.parse(body.result.content[0].text) : null;
  say(!!parsed?.count, `MCP get_readings noaa-coops station 8518750 → ${parsed ? `${parsed.count} readings, ${parsed.readings[0]?.place?.name}` : JSON.stringify(body).slice(0, 200)}`);
} finally {
  srv.close();
}

console.log(failed ? `\n${failed} failed` : '\nall live checks passed');
process.exitCode = failed ? 1 : 0;
