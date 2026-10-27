/**
 * adsb.lol: live aircraft positions from a community network of ADS-B receivers (ODbL 1.0).
 * https://api.adsb.lol/docs
 *
 *   params.mode    area (default) | military | gps
 *     area      every aircraft within params.radius nautical miles of each named place (lat=, lng=)
 *     military  every aircraft the readsb database flags as military, worldwide (/v2/mil)
 *     gps       GPS interference per 1° cell, derived from the same positions (see below)
 *   params.radius  nautical miles around each place, 1-250 (default 100; gps default 250)
 *
 * Aircraft whose owners have asked to be hidden (FAA LADD, and PIA privacy addresses; readsb dbFlags
 * 8 and 4) are dropped here even when the upstream returns them: that programme exists for exactly
 * this kind of map. Military aircraft are served; that is the "watch power, not people" layer.
 *
 * GPS interference follows the GPSJam method: an aircraft broadcasts how sure it is of its own position
 * (NACp). When jamming or spoofing degrades GNSS, NACp drops. Per cell, the share of aircraft reporting
 * NACp below 8 is the reading. ADS-B version 0 transponders do not report NACp meaningfully and are left
 * out, and a cell needs at least MIN_AIRCRAFT reporting aircraft before it is said to be anything, and
 * MIN_DEGRADED degraded ones before it is called medium or high.
 * These readings are inferred, not measured, so they carry basis 'derived' and say what from.
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';

const MODES = ['area', 'military', 'gps'];
const PRIVATE = 4 | 8; // PIA, LADD
const MILITARY = 1;
export const GOOD_NACP = 8;
export const MIN_AIRCRAFT = 5;
export const MIN_DEGRADED = 2;

// Where mode=gps looks when no place is named: regions where interference has been reported publicly,
// plus a quiet control over the US Great Lakes. Name a place to look anywhere else.
export const WATCH_REGIONS = [
  { id: 'watch-baltic', name: 'Baltic Sea', lat: 56, lng: 20 },
  { id: 'watch-east-med', name: 'Eastern Mediterranean', lat: 34, lng: 34 },
  { id: 'watch-persian-gulf', name: 'Persian Gulf', lat: 26.5, lng: 52 },
  { id: 'watch-red-sea', name: 'Red Sea', lat: 20, lng: 39 },
  { id: 'watch-great-lakes', name: 'US Great Lakes (control)', lat: 42.5, lng: -82 },
];

function radiusOf(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 250) throw Object.assign(new Error('radius must be 1-250 nautical miles'), { status: 400 });
  return Math.round(n);
}

const altitude = (a) => (a.alt_baro === 'ground' ? 0 : Number.isFinite(a.alt_baro) ? a.alt_baro : Number.isFinite(a.alt_geom) ? a.alt_geom : null);
const callsign = (a) => (a.flight || '').trim() || null;

// One call at a time: adsb.lol limits by load, and parallel calls from one client are refused. With several
// places, a place that fails is left out (it says so in `missed`); only all of them failing is an error.
async function positions(f, urls) {
  const pages = [];
  const missed = [];
  let last;
  for (const u of urls) {
    try { pages.push(await getJson(f, u, {}, 20000)); } catch (e) { last = e; missed.push(u); }
  }
  if (!pages.length && last) throw last;
  const seen = new Map();
  for (const p of pages) {
    for (const a of p.ac || []) {
      if (!a.hex || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || (a.dbFlags & PRIVATE)) continue;
      seen.set(a.hex, { a, now: p.now });
    }
  }
  return Object.assign([...seen.values()], { missed });
}

const partly = (ac, total) => (ac.missed.length ? { detail: `${ac.missed.length} of ${total} places did not answer and are left out` } : {});

export const adsbLol = {
  source: 'adsb-lol',
  metrics: ['aircraft', 'gps_interference'],
  places: 'mode=area: lat= and lng= (up to ten places); mode=military: none; mode=gps: lat=/lng= or five watched regions',
  params: { mode: MODES, radius: 'nautical miles, 1-250' },
  async fetch({ fetch: f, now, src, places = [], params = {} }) {
    const source = src('adsb-lol');
    const mode = MODES.includes(params.mode) ? params.mode : 'area';
    const fetchedAt = now.toISOString();
    const placed = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    if (mode === 'gps') {
      const radius = radiusOf(params.radius, 250);
      const regions = placed.length ? placed : WATCH_REGIONS;
      const ac = await positions(f, regions.map((p) => `https://api.adsb.lol/v2/point/${p.lat}/${p.lng}/${radius}`));
      return { status: 'ok', readings: gpsCells(ac, { source, fetchedAt, now }), ...partly(ac, regions.length) };
    }

    let urls;
    if (mode === 'military') urls = ['https://api.adsb.lol/v2/mil'];
    else {
      if (!placed.length) throw Object.assign(new Error('mode=area needs a place: lat= and lng= (or mode=military for the worldwide military list)'), { status: 400 });
      const radius = radiusOf(params.radius, 100);
      urls = placed.map((p) => `https://api.adsb.lol/v2/point/${p.lat}/${p.lng}/${radius}`);
    }
    const out = [];
    const ac = await positions(f, urls);
    for (const { a, now: t } of ac) {
      const at = new Date((Number.isFinite(t) ? t : now.getTime()) - (Number(a.seen_pos) || 0) * 1000).toISOString();
      const alt = altitude(a);
      const cs = callsign(a);
      const label = [cs, a.r, a.t].filter(Boolean).join(' · ') || a.hex;
      out.push(reading({
        source, id: `${a.hex}:${at.slice(0, 16)}`, at, metric: 'aircraft',
        place: { id: `ac-${a.hex}`, name: label, lat: a.lat, lng: a.lon },
        value: alt, unit: 'ft (barometric; 0 on the ground)',
        summary: `${label}${alt === 0 ? ' on the ground' : alt != null ? ` at ${alt.toLocaleString('en-US')} ft` : ''}${Number.isFinite(a.gs) ? `, ${Math.round(a.gs)} kt` : ''}${a.emergency && a.emergency !== 'none' ? `, emergency: ${a.emergency}` : ''}`,
        fields: { hex: a.hex, callsign: cs, registration: a.r ?? null, type: a.t ?? null, category: a.category ?? null, military: !!(a.dbFlags & MILITARY),
          ground_speed_kt: a.gs ?? null, track_deg: a.track ?? a.true_heading ?? null, squawk: a.squawk ?? null, emergency: a.emergency ?? null,
          nac_p: a.nac_p ?? null, adsb_version: a.version ?? null, source_type: a.type ?? null },
        url: `https://globe.adsb.lol/?icao=${a.hex}`, fetchedAt,
      }));
    }
    return { status: 'ok', readings: out, ...partly(ac, urls.length) };
  },
};

/** One reading per 1° cell with at least MIN_AIRCRAFT aircraft that report NACp. */
export function gpsCells(ac, { source, fetchedAt, now }) {
  const cells = new Map();
  for (const { a } of ac) {
    if (!Number.isFinite(a.nac_p) || !(a.version >= 1) || a.alt_baro === 'ground') continue;
    const key = `${Math.floor(a.lat)}_${Math.floor(a.lon)}`;
    const c = cells.get(key) || cells.set(key, { lat: Math.floor(a.lat), lng: Math.floor(a.lon), n: 0, bad: 0 }).get(key);
    c.n += 1;
    if (a.nac_p < GOOD_NACP) c.bad += 1;
  }
  const minute = `${now.toISOString().slice(0, 16)}:00Z`;
  const deg = (v, pos, neg) => `${Math.abs(v)}°${v >= 0 ? pos : neg}`;
  const out = [];
  for (const [key, c] of cells) {
    if (c.n < MIN_AIRCRAFT) continue;
    const pct = Math.round((c.bad / c.n) * 1000) / 10;
    // one aircraft with faulty avionics is not interference: it takes two degraded to call a cell anything
    const level = c.bad < MIN_DEGRADED ? 'low' : pct > 10 ? 'high' : pct >= 2 ? 'medium' : 'low';
    const name = `cell ${deg(c.lat, 'N', 'S')} ${deg(c.lng, 'E', 'W')} (1°, south-west corner)`;
    out.push(reading({
      source, id: `gps:${key}:${minute}`, at: minute, metric: 'gps_interference',
      place: { id: `cell-${key}`, name, lat: c.lat + 0.5, lng: c.lng + 0.5 },
      value: pct, unit: '% of aircraft with degraded position accuracy',
      summary: `${level} GPS interference: ${c.bad} of ${c.n} aircraft report NACp below ${GOOD_NACP}`,
      basis: 'derived', derivedFrom: `adsb.lol aircraft positions (NACp), ${c.n} aircraft in this cell`,
      fields: { level, aircraft: c.n, degraded: c.bad, nacp_threshold: GOOD_NACP, cell_deg: 1, method: 'GPSJam method: share of ADS-B v1+ airborne aircraft with NACp < 8' },
      url: 'https://gpsjam.org/faq', fetchedAt,
    }));
  }
  return out;
}
