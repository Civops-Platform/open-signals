/**
 * NASA FIRMS: VIIRS 375 m active fire and thermal anomaly detections, from the keyless near-real-time
 * global CSV files (no MAP_KEY needed for these). NASA data are CC0; cite "NASA FIRMS".
 * https://www.earthdata.nasa.gov/data/tools/firms/faq
 *
 *   params.mode  fires (default) | persistent | steel
 *     fires       every detection of the last 24 hours (NOAA-20), nominal or high confidence, inside
 *                 params.bbox (default the whole world); at most MAX_FIRES, the strongest kept
 *     persistent  ~1 km cells with heat on PERSISTENT_DAYS or more of the last seven days (Suomi NPP). A
 *                 vegetation fire moves on within days; heat that stays put is usually an industrial
 *                 source (steel, cement, refinery), a gas flare or a volcano. Each cell names the nearest
 *                 steel plant and thermal power plant in Global Energy Monitor's trackers within NEAR_KM.
 *     steel       every blast-furnace or DRI steel plant in GEM's Global Iron and Steel Tracker (operating,
 *                 pre-retirement, mothballed or building), with the days of the last seven that VIIRS saw
 *                 heat within NEAR_KM of it, and its owner and parent company. Electric-arc mini-mills are
 *                 left out: they run too cool to show reliably, so a zero would say nothing.
 *   params.bbox  xmin,ymin,xmax,ymax
 *
 * FIRMS's own static-source classification is not distributed, so "persistent" is worked out here, from
 * the detections alone, and carries basis 'derived'. A long-burning wildfire can also look persistent.
 */

import { reading } from '../contract.js';
import { getText } from './http.js';
import { readFileSync } from 'node:fs';
import { powerPlantTable } from './power-plants.js';

const MODES = ['fires', 'persistent', 'steel'];
const FIRES_24H = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv';
const SNPP_7D = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_7d.csv';
export const MAX_FIRES = 5000;
export const PERSISTENT_DAYS = 3;
export const NEAR_KM = 3;
const CELL = 0.01; // degrees, about 1.1 km of latitude
const THERMAL = new Set(['coal', 'oil/gas', 'bioenergy']);

function bbox(v) {
  if (v == null || v === '') return null;
  const b = String(v).split(',').map(Number);
  if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3] || Math.abs(b[0]) > 180 || Math.abs(b[2]) > 180 || Math.abs(b[1]) > 90 || Math.abs(b[3]) > 90) {
    throw Object.assign(new Error('bbox must be xmin,ymin,xmax,ymax in degrees'), { status: 400 });
  }
  return b;
}

/** FIRMS CSV (unquoted) → objects, one line at a time. */
function* rows(text) {
  let start = text.indexOf('\n') + 1;
  const keys = text.slice(0, start - 1).trim().split(',');
  while (start > 0 && start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    const v = line.split(',');
    yield Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  }
}

const at = (d) => `${d.acq_date}T${String(d.acq_time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z`;
const inside = (b, lat, lng) => !b || (lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]);

const gridOf = (items) => {
  const g = new Map();
  for (const p of items) { const k = `${Math.floor(p.lat)}_${Math.floor(p.lng)}`; (g.get(k) || g.set(k, []).get(k)).push(p); }
  return g;
};

let plantGrid = null;
/** Thermal power plants from the GEM table, by whole-degree cell. */
function thermalPlants() {
  if (plantGrid) return plantGrid;
  const t = powerPlantTable();
  const ix = Object.fromEntries(t.fields.map((k, i) => [k, i]));
  const items = [];
  for (const p of t.plants) {
    const fuels = [p[ix.fuel], ...(p[ix.other_fuels] || [])].map((i) => t.fuels[i]);
    if (!fuels.some((f) => THERMAL.has(f)) || p[ix.location_approximate]) continue;
    items.push({ id: p[ix.project_id], name: p[ix.name], lat: p[ix.lat], lng: p[ix.lng], fuels, mw: Math.round(p[ix.operating_mw] + p[ix.construction_mw]) });
  }
  return (plantGrid = gridOf(items));
}

let steel = null;
/** GEM iron and steel plants (catalog/steel-plants.json, built by scripts/build-steel-plants.mjs). */
export function steelPlants() {
  if (steel) return steel;
  const t = JSON.parse(readFileSync(new URL('../../catalog/steel-plants.json', import.meta.url), 'utf8'));
  const ix = Object.fromEntries(t.fields.map((k, i) => [k, i]));
  const all = t.plants.map((p) => Object.assign(Object.fromEntries(t.fields.map((k) => [k, p[ix[k]]])), { url: p[ix.wiki] ? `${t.wiki}${p[ix.wiki]}` : t.source }));
  return (steel = { release: t.release, all, hot: all.filter((p) => /BF|DRI/.test(p.prod_type || '')), grid: gridOf(all.filter((p) => p.location_exact)) });
}

const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

function nearest(grid, pt) {
  let best = null;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const p of grid.get(`${Math.floor(pt.lat) + dy}_${Math.floor(pt.lng) + dx}`) || []) {
      const d = km(pt, p);
      if (d <= NEAR_KM && (!best || d < best.km)) best = { ...p, km: Math.round(d * 10) / 10 };
    }
  }
  return best;
}

export const nearestThermalPlant = (pt) => nearest(thermalPlants(), pt);
export const nearestSteelPlant = (pt) => nearest(steelPlants().grid, pt);

/**
 * Seven days of Suomi NPP detections, nominal or high confidence, inside the box. The file is a rolling
 * 7 x 24 hours, so it touches eight UTC dates; `span` is how many it holds, the denominator for "days with heat".
 */
async function week(f, b) {
  const text = await getText(f, SNPP_7D, {}, 120000);
  const out = [];
  const dates = new Set();
  for (const d of rows(text)) {
    if (d.acq_date) dates.add(d.acq_date);
    const lat = Number(d.latitude), lng = Number(d.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || d.confidence === 'low' || d.confidence === 'l' || !inside(b, lat, lng)) continue;
    out.push({ lat, lng, day: d.acq_date, at: at(d), frp: Number(d.frp) || 0 });
  }
  return Object.assign(out, { span: dates.size || 7 });
}

export const nasaFirms = {
  source: 'nasa-firms',
  metrics: ['fire_detection', 'persistent_heat'],
  places: 'none needed: each detection carries its position; bbox narrows it',
  params: { mode: MODES, bbox: 'xmin,ymin,xmax,ymax' },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('nasa-firms');
    const mode = MODES.includes(params.mode) ? params.mode : 'fires';
    const b = bbox(params.bbox);
    const fetchedAt = now.toISOString();
    if (mode === 'fires') {
      const text = await getText(f, FIRES_24H, {}, 60000);
      let hits = [];
      for (const d of rows(text)) {
        const lat = Number(d.latitude), lng = Number(d.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || d.confidence === 'low' || d.confidence === 'l' || !inside(b, lat, lng)) continue;
        hits.push({ d, lat, lng, frp: Number(d.frp) || 0 });
      }
      const total = hits.length;
      if (total > MAX_FIRES) hits = hits.sort((x, y) => y.frp - x.frp).slice(0, MAX_FIRES);
      const readings = hits.map(({ d, lat, lng, frp }) => reading({
        source, id: `${d.satellite}:${d.acq_date}:${d.acq_time}:${lat}:${lng}`, at: at(d), metric: 'fire_detection',
        place: { id: `fire-${lat}_${lng}`, name: `${lat.toFixed(3)}, ${lng.toFixed(3)}`, lat, lng },
        value: frp, unit: 'MW fire radiative power',
        summary: `Heat detected ${d.daynight === 'D' ? 'by day' : 'at night'} ${at(d).slice(0, 16).replace('T', ' ')} UTC, ${frp} MW radiative power, ${d.confidence} confidence`,
        fields: { confidence: d.confidence, frp_mw: frp, brightness_k: Number(d.bright_ti4) || null, daynight: d.daynight, satellite: d.satellite, scan_km: Number(d.scan) || null },
        url: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lng.toFixed(3)},${lat.toFixed(3)},11z`, fetchedAt,
      }));
      return { status: 'ok', readings, ...(total > MAX_FIRES ? { detail: `${total} detections; the ${MAX_FIRES} strongest are served, narrow bbox for the rest` } : {}) };
    }

    const dets = await week(f, b);
    if (mode === 'steel') return { status: 'ok', readings: steelActivity(dets, { source, fetchedAt, now }) };
    const span = dets.span;
    const cells = new Map();
    for (const d of dets) {
      const key = `${Math.floor(d.lat / CELL)}_${Math.floor(d.lng / CELL)}`;
      const c = cells.get(key) || cells.set(key, { days: new Set(), n: 0, frp: 0, maxFrp: 0, lat: 0, lng: 0, last: '' }).get(key);
      c.days.add(d.day); c.n += 1; c.frp += d.frp; c.lat += d.lat; c.lng += d.lng;
      if (d.frp > c.maxFrp) c.maxFrp = d.frp;
      if (d.at > c.last) c.last = d.at;
    }
    const out = [];
    for (const [key, c] of cells) {
      if (c.days.size < PERSISTENT_DAYS) continue;
      const pt = { lat: Math.round((c.lat / c.n) * 1e4) / 1e4, lng: Math.round((c.lng / c.n) * 1e4) / 1e4 };
      const plant = nearestThermalPlant(pt);
      const mill = nearestSteelPlant(pt);
      out.push(reading({
        source, id: `persistent:${key}:${c.last.slice(0, 10)}`, at: c.last, metric: 'persistent_heat',
        place: { id: `heat-${key}`, name: mill ? `near ${mill.name}` : plant ? `near ${plant.name}` : `${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)}`, ...pt },
        value: c.days.size, unit: 'UTC dates with heat',
        summary: `Heat on ${c.days.size} of the last ${span} UTC dates (${c.n} detections, mean ${Math.round(c.frp / c.n)} MW)`
          + (mill ? `, ${mill.km} km from ${mill.name} (steel${mill.owner ? `, ${mill.owner}` : ''})` : plant ? `, ${plant.km} km from ${plant.name} (${plant.fuels.join(' + ')}, ${plant.mw} MW)` : '')
          + ': likely an industrial source, gas flare or volcano rather than a wildfire',
        basis: 'derived', derivedFrom: `NASA FIRMS VIIRS (Suomi NPP) detections, ${c.n} in this ~1 km cell over 7 days`,
        fields: { days: c.days.size, of_days: span, detections: c.n, mean_frp_mw: Math.round((c.frp / c.n) * 10) / 10, max_frp_mw: c.maxFrp, last_seen: c.last,
          near_plant: plant ? { gem_project_id: plant.id, name: plant.name, fuels: plant.fuels, capacity_mw: plant.mw, km: plant.km } : null,
          near_steel_plant: mill ? { gem_project_id: mill.project_id, name: mill.name, owner: mill.owner, parent: mill.parent, km: mill.km } : null },
        url: `https://firms.modaps.eosdis.nasa.gov/map/#d:7days;@${pt.lng.toFixed(3)},${pt.lat.toFixed(3)},13z`, fetchedAt,
      }));
    }
    return { status: 'ok', readings: out };
  },
};

/** Per blast-furnace or DRI steel plant: days of the last seven with heat within NEAR_KM. */
export function steelActivity(dets, { source, fetchedAt, now }) {
  const { hot, release } = steelPlants();
  const g = gridOf(dets);
  const minute = `${now.toISOString().slice(0, 16)}:00Z`;
  const span = dets.span ?? 7;
  return hot.map((p) => {
    const days = new Set();
    let n = 0, frp = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const d of g.get(`${Math.floor(p.lat) + dy}_${Math.floor(p.lng) + dx}`) || []) {
        if (km(p, d) > NEAR_KM) continue;
        days.add(d.day); n += 1; frp += d.frp;
      }
    }
    const who = [p.owner, p.parent && p.parent !== `${p.owner} [100.0%]` ? `parent ${p.parent}` : null].filter(Boolean).join('; ');
    return reading({
      source, id: `steel:${p.project_id}:${minute.slice(0, 10)}`, at: minute, metric: 'steel_plant_heat',
      place: { id: `gem-${p.project_id}`, name: p.name, lat: p.lat, lng: p.lng },
      value: days.size, unit: 'UTC dates with heat',
      summary: `${p.name}${who ? ` (${who})` : ''}: heat on ${days.size} of the last ${span} UTC dates${n ? `, ${n} detections` : ''}; ${p.status}, ${p.prod_type}${p.capacity_kt ? `, ${p.capacity_kt.toLocaleString('en-US')} kt/yr` : ''}`,
      basis: 'derived', derivedFrom: `NASA FIRMS VIIRS (Suomi NPP) detections within ${NEAR_KM} km, matched to GEM Global Iron and Steel Tracker ${release}`,
      fields: { days: days.size, of_days: span, detections: n, mean_frp_mw: n ? Math.round((frp / n) * 10) / 10 : null, gem_project_id: p.project_id, owner: p.owner, parent: p.parent,
        country: p.country, status: p.status, prod_type: p.prod_type, tech: p.tech, capacity_kt: p.capacity_kt, location_exact: p.location_exact, gem_release: release },
      url: p.url, fetchedAt,
    });
  });
}
