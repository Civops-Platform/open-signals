/**
 * Corroboration: the same event seen by two independent sources, or by only one. An event two agencies
 * or two kinds of sensor agree on is firmer than one only one of them reports; a disagreement is worth
 * a look. Every reading here is derived, says which inputs it came from, and links both.
 *
 *   params.mode  earthquakes (default) | fires
 *     earthquakes  USGS and EMSC-CSEM catalogues for the same window (params.window hour | day | week,
 *                  params.min all | 2.5 | 4.5). Two events are the same when their origins are within
 *                  QUAKE_KM and QUAKE_S. Value: independent agencies that report it (1 or 2). When EMSC's
 *                  authoring agency is a network USGS also carries (USGS_NETWORKS), the match is marked
 *                  relayed and counts once. Fields give each one's magnitude and the gap between them.
 *     fires        US wildfire incidents in NIFC WFIGS against NASA FIRMS VIIRS detections of the last
 *                  24 hours within FIRE_KM of the incident's point of origin. Value: detections near it. An
 *                  incident with none is not necessarily out (small, smouldering, under cloud, or the fire
 *                  has moved off its origin); a large one with many is burning now.
 *
 * Inputs are run through their own fetchers, so their licences and caches are theirs; this source's
 * licence is the strictest of its inputs (all four are public domain or CC BY).
 */

import { reading } from '../contract.js';
import { usgsEarthquakes } from './usgs-earthquakes.js';
import { emsc } from './world-hazards.js';
import { nifcWfigs } from './us-water-hazards.js';
import { nasaFirms } from './firms.js';

const MODES = ['earthquakes', 'fires'];
export const QUAKE_KM = 100;
export const QUAKE_S = 60;
export const FIRE_KM = 5;
// Networks whose solutions USGS ComCat carries: when EMSC's authoring agency is one of these, EMSC is relaying
// the same solution, so a match is not a second opinion.
export const USGS_NETWORKS = new Set(['US', 'NEIC', 'USGS', 'AK', 'AT', 'CI', 'HV', 'MB', 'NC', 'NM', 'NN', 'OK', 'PR', 'SE', 'TX', 'UU', 'UW', 'WY', 'AV', 'LD', 'GU', 'PT']);
const US_BBOX = '-170,17,-64,72';

const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};
const mag = (r) => (r ? `M${r.value ?? '?'}` : '');

export const corroboration = {
  source: 'corroboration',
  metrics: ['earthquake_corroboration', 'fire_corroboration'],
  places: 'none needed: each event carries its own point',
  params: { mode: MODES, window: ['hour', 'day', 'week'], min: ['all', '2.5', '4.5'] },
  async fetch(ctx) {
    const { now, src, params = {} } = ctx;
    const source = src('corroboration');
    const mode = MODES.includes(params.mode) ? params.mode : 'earthquakes';
    const fetchedAt = now.toISOString();
    return mode === 'fires' ? fires(ctx, source, fetchedAt) : quakes(ctx, source, fetchedAt);
  },
};

async function quakes(ctx, source, fetchedAt) {
  const window = ['hour', 'day', 'week'].includes(ctx.params?.window) ? ctx.params.window : 'day';
  const min = ['all', '2.5', '4.5'].includes(ctx.params?.min) ? ctx.params.min : '2.5';
  const sub = { ...ctx, params: { window, min } };
  const [us, eu] = await Promise.all([usgsEarthquakes.fetch(sub), emsc.fetch(sub)]);
  const floor = min === 'all' ? -Infinity : Number(min);
  const a = us.readings.filter((r) => r.place && (r.value ?? 0) >= floor);
  const b = eu.readings.filter((r) => r.place && (r.value ?? 0) >= floor);
  const used = new Set();
  const out = [];
  const emit = (u, e, d, dt) => {
    const first = u || e, both = !!(u && e);
    const relayed = both && USGS_NETWORKS.has(String(e.fields?.agency || '').toUpperCase());
    const gap = both && Number.isFinite(u.value) && Number.isFinite(e.value) ? Math.round((u.value - e.value) * 10) / 10 : null;
    out.push(reading({
      source, id: `quake:${u?.id ?? '-'}:${e?.id ?? '-'}`, at: first.at, metric: 'earthquake_corroboration',
      place: { id: `corr-${(u || e).place.id}`, name: first.place.name, lat: first.place.lat, lng: first.place.lng },
      value: both && !relayed ? 2 : 1, unit: 'independent agencies reporting (of USGS and EMSC)',
      summary: relayed
        ? `${mag(u)} ${u.place.name}: USGS, and EMSC relaying the ${e.fields.agency} solution (one source, not two)`
        : both
          ? `${mag(u)} ${u.place.name}: USGS and EMSC (${e.fields?.agency || 'EMSC'}) agree, EMSC ${mag(e)}, origins ${Math.round(d)} km and ${Math.round(dt)} s apart`
          : `${mag(first)} ${first.place.name}: reported by ${u ? 'USGS' : 'EMSC'} only`,
      basis: 'derived', derivedFrom: `USGS earthquakes and EMSC-CSEM SeismicPortal, ${window}, M${min}+; matched within ${QUAKE_KM} km and ${QUAKE_S} s`,
      fields: { corroborated: both && !relayed, relayed, emsc_agency: e?.fields?.agency ?? null, usgs_id: u?.id ?? null, emsc_id: e?.id ?? null, mag_usgs: u?.value ?? null, mag_emsc: e?.value ?? null, mag_gap: gap,
        distance_km: both ? Math.round(d * 10) / 10 : null, time_gap_s: both ? Math.round(dt) : null, usgs_url: u?.source.url ?? null, emsc_url: e?.source.url ?? null },
      url: u?.source.url ?? e?.source.url, fetchedAt,
    }));
  };
  for (const u of a) {
    let best = null;
    for (const [i, e] of b.entries()) {
      if (used.has(i)) continue;
      const dt = Math.abs(Date.parse(u.at) - Date.parse(e.at)) / 1000;
      if (dt > QUAKE_S) continue;
      const d = km(u.place, e.place);
      if (d <= QUAKE_KM && (!best || dt + d < best.dt + best.d)) best = { i, e, d, dt };
    }
    if (best) used.add(best.i);
    emit(u, best?.e, best?.d, best?.dt);
  }
  b.forEach((e, i) => { if (!used.has(i)) emit(null, e); });
  return { status: 'ok', readings: out };
}

async function fires(ctx, source, fetchedAt) {
  const [inc, sat] = await Promise.all([nifcWfigs.fetch({ ...ctx, params: { kind: 'wildfire' } }), nasaFirms.fetch({ ...ctx, params: { mode: 'fires', bbox: US_BBOX } })]);
  const grid = new Map();
  for (const d of sat.readings) {
    const k = `${Math.floor(d.place.lat * 10)}_${Math.floor(d.place.lng * 10)}`;
    (grid.get(k) || grid.set(k, []).get(k)).push(d);
  }
  const out = [];
  for (const r of inc.readings) {
    if (!r.place) continue;
    const near = [];
    const y = Math.floor(r.place.lat * 10), x = Math.floor(r.place.lng * 10);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const d of grid.get(`${y + dy}_${x + dx}`) || []) if (km(r.place, d.place) <= FIRE_KM) near.push(d);
    }
    const frp = Math.round(near.reduce((s, d) => s + (d.value || 0), 0));
    out.push(reading({
      source, id: `fire:${r.fields.unique_fire_id}:${fetchedAt.slice(0, 13)}`, at: near.length ? near.map((d) => d.at).sort().at(-1) : r.at, metric: 'fire_corroboration',
      place: { id: `corr-${r.place.id}`, name: r.place.name, lat: r.place.lat, lng: r.place.lng, ...(r.place.state ? { state: r.place.state } : {}) },
      value: near.length, unit: `VIIRS detections within ${FIRE_KM} km, last 24 h`,
      summary: near.length
        ? `${r.place.name}: ${r.value ?? '?'} acres reported, and the satellite saw heat ${near.length} time${near.length === 1 ? '' : 's'} within ${FIRE_KM} km today (${frp} MW in all)`
        : `${r.place.name}: ${r.value ?? '?'} acres reported, no satellite heat within ${FIRE_KM} km today (small, smouldering, clouded over, or moved off its origin)`,
      basis: 'derived', derivedFrom: `NIFC WFIGS incident points and NASA FIRMS VIIRS (NOAA-20) detections of the last 24 h, within ${FIRE_KM} km`,
      fields: { corroborated: near.length > 0, detections: near.length, frp_mw: frp, acres: r.value, percent_contained: r.fields.percent_contained ?? null,
        unique_fire_id: r.fields.unique_fire_id, incident_url: r.source.url },
      url: r.source.url, fetchedAt,
    }));
  }
  return { status: 'ok', readings: out, ...(sat.detail ? { detail: `FIRMS: ${sat.detail}` } : {}) };
}
