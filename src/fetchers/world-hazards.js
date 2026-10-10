/**
 * Hazards outside the US feeds, so the map is not only American.
 *
 *   emsc      EMSC-CSEM SeismicPortal earthquakes (FDSN event service), worldwide and dense over
 *             Europe and the Mediterranean. Keyless. Datasets CC BY 4.0: credit EMSC-CSEM.
 *             https://www.seismicportal.eu/terms.html
 *   ibtracs   NOAA NCEI IBTrACS v04r01 "ACTIVE" best tracks: the latest fix of every tropical
 *             cyclone in any basin. Keyless; NOAA lists no use constraints beyond citation.
 *             US positions and winds (NHC/JTWC, the USA_* columns) are used where present.
 */

import { reading } from '../contract.js';
import { getText } from './http.js';

const EMSC_WINDOWS = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3 };
const EMSC_FLOORS = { all: null, '2.5': 2.5, '4.5': 4.5 };
const EMSC_LIMIT = 1000;

export const emsc = {
  source: 'emsc',
  metrics: ['earthquake'],
  places: 'none needed: every event carries its epicentre',
  params: { window: Object.keys(EMSC_WINDOWS), min: Object.keys(EMSC_FLOORS) },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('emsc');
    const span = EMSC_WINDOWS[params.window] ?? EMSC_WINDOWS.day;
    const floor = EMSC_FLOORS[params.min] ?? null;
    const start = new Date(now.getTime() - span).toISOString().slice(0, 19);
    const url = `https://www.seismicportal.eu/fdsnws/event/1/query?format=json&orderby=time&limit=${EMSC_LIMIT}&starttime=${start}${floor != null ? `&minmag=${floor}` : ''}`;
    const text = await getText(f, url, { headers: { Accept: 'application/json' } }, 30000);
    const data = text.trim() ? JSON.parse(text) : null; // FDSN answers 204 with no body when nothing matched
    const out = [];
    for (const ft of data?.features || []) {
      const p = ft.properties || {};
      const lat = Number(p.lat ?? ft.geometry?.coordinates?.[1]), lng = Number(p.lon ?? ft.geometry?.coordinates?.[0]);
      const t = Date.parse(p.time);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(t)) continue;
      const id = p.unid || ft.id;
      const depth = Number.isFinite(Number(p.depth)) ? Number(p.depth) : null;
      const region = p.flynn_region ? titleCase(p.flynn_region) : 'unnamed region';
      out.push(reading({
        source, id, at: new Date(t).toISOString(), metric: 'earthquake',
        place: { id: `emsc-${id}`, name: region, lat, lng },
        value: p.mag, unit: p.magtype ? `magnitude (${p.magtype})` : 'magnitude',
        summary: `M${p.mag ?? '?'} ${region}${depth != null ? `, ${Math.round(depth * 10) / 10} km deep` : ''}`,
        // auth is the reporting agency's code (e.g. NDI, IGC), never a person.
        fields: { depth_km: depth, region: p.flynn_region ?? null, agency: p.auth ?? null, event_type: p.evtype ?? null, last_update: p.lastupdate ?? null },
        url: `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(id)}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s,.(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

const IBTRACS_URL = 'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv';
const IBTRACS_RECENT_DAYS = 7;
const BASINS = { NA: 'North Atlantic', EP: 'Eastern North Pacific', WP: 'Western North Pacific', NI: 'North Indian', SI: 'South Indian', SP: 'South Pacific', SA: 'South Atlantic', MM: 'unassigned' };
const NATURE = { TS: 'tropical', ET: 'extratropical', DS: 'disturbance', SS: 'subtropical', NR: 'not reported', MX: 'mixed reports' };
const SSHS = { '-5': 'unknown', '-4': 'post-tropical', '-3': 'disturbance', '-2': 'subtropical', '-1': 'tropical depression', 0: 'tropical storm', 1: 'category 1', 2: 'category 2', 3: 'category 3', 4: 'category 4', 5: 'category 5' };

const numOrNull = (v) => (v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const lng180 = (x) => (x > 180 ? x - 360 : x);

export const ibtracs = {
  source: 'noaa-ibtracs',
  metrics: ['tropical_cyclone'],
  places: 'none needed: each storm is placed at its latest fix',
  async fetch({ fetch: f, now, src }) {
    const source = src('noaa-ibtracs');
    const text = await getText(f, IBTRACS_URL, {}, 60000);
    const lines = text.split(/\r?\n/);
    const head = (lines.shift() || '').split(',').map((s) => s.trim());
    const ix = Object.fromEntries(head.map((h, i) => [h, i]));
    if (ix.SID == null || ix.ISO_TIME == null) throw new Error('IBTrACS CSV header not recognised');
    const last = new Map();
    for (const line of lines) {
      const c = line.split(',');
      const sid = c[ix.SID]?.trim();
      if (!sid || !/^\d{7}[NS]\d{5}$/.test(sid)) continue; // skips the units row and blanks
      const prev = last.get(sid);
      if (!prev || c[ix.ISO_TIME] >= prev[ix.ISO_TIME]) last.set(sid, c);
    }
    const at = (c) => Date.parse(`${c[ix.ISO_TIME].trim().replace(' ', 'T')}Z`);
    const newest = Math.max(...[...last.values()].map(at).filter(Number.isFinite));
    const out = [];
    for (const [sid, c] of last) {
      const t = at(c);
      if (!Number.isFinite(t) || newest - t > IBTRACS_RECENT_DAYS * 86400e3) continue;
      const lat = numOrNull(c[ix.USA_LAT]) ?? numOrNull(c[ix.LAT]);
      const lon = numOrNull(c[ix.USA_LON]) ?? numOrNull(c[ix.LON]);
      if (lat == null || lon == null) continue;
      const lng = lng180(lon);
      const name = c[ix.NAME]?.trim() || 'UNNAMED';
      const label = name === 'UNNAMED' || name === 'NOT_NAMED' ? `Unnamed system ${sid}` : name.charAt(0) + name.slice(1).toLowerCase();
      const wind = numOrNull(c[ix.USA_WIND]) ?? numOrNull(c[ix.WMO_WIND]);
      const pres = numOrNull(c[ix.USA_PRES]) ?? numOrNull(c[ix.WMO_PRES]);
      const sshs = numOrNull(c[ix.USA_SSHS]);
      const basin = c[ix.BASIN]?.trim();
      const cat = sshs != null ? SSHS[sshs] ?? null : null;
      out.push(reading({
        source, id: `${sid}:${new Date(t).toISOString()}`, at: new Date(t).toISOString(), metric: 'tropical_cyclone',
        place: { id: `ibtracs-${sid}`, name: label, lat, lng },
        value: wind, unit: 'kt (max sustained wind)',
        summary: `${label} (${BASINS[basin] || basin || 'unknown basin'}): ${wind != null ? `${wind} kt` : 'wind not reported'}${cat ? `, ${cat}` : ''}${pres != null ? `, ${pres} hPa` : ''}, fix ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        fields: { sid, name, basin: basin || null, nature: NATURE[c[ix.NATURE]?.trim()] ?? c[ix.NATURE]?.trim() ?? null, sshs, category: cat, pressure_hpa: pres,
          wind_agency: numOrNull(c[ix.USA_WIND]) != null ? (c[ix.USA_AGENCY]?.trim() || 'usa') : (c[ix.WMO_AGENCY]?.trim() || null),
          atcf_id: c[ix.USA_ATCF_ID]?.trim() || null, dist_to_land_km: numOrNull(c[ix.DIST2LAND]), track_type: c[ix.TRACK_TYPE]?.trim() || null },
        url: 'https://www.ncei.noaa.gov/products/international-best-track-archive', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
