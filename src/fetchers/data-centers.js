/**
 * Data centers mapped in OpenStreetMap, from catalog/data-centers.json (built by scripts/build-data-centers.mjs;
 * ODbL 1.0, © OpenStreetMap contributors). No network: the worldwide Overpass query is too slow to run per
 * request, so the table is rebuilt on a schedule. OSM is volunteer-mapped: coverage is good for large
 * campuses in North America and Europe and thin elsewhere, and a site under construction appears only once
 * someone maps it.
 *   params.operator  case-insensitive match on the normalised operator (e.g. "Microsoft", "equinix")
 *   params.status    all (default) | operating | construction
 *   params.bbox      xmin,ymin,xmax,ymax
 */

import { readFileSync } from 'node:fs';
import { reading } from '../contract.js';

let table = null;
export function dataCenterTable() {
  if (!table) {
    const t = JSON.parse(readFileSync(new URL('../../catalog/data-centers.json', import.meta.url), 'utf8'));
    const ix = Object.fromEntries(t.fields.map((k, i) => [k, i]));
    table = { ...t, all: t.sites.map((s) => Object.fromEntries(t.fields.map((k) => [k, s[ix[k]]]))) };
  }
  return table;
}
const STATUSES = ['all', 'operating', 'construction'];
const bad = (m) => Object.assign(new Error(m), { status: 400 });

export const osmDataCenters = {
  source: 'osm-data-centers',
  metrics: ['data_center'],
  places: 'none needed: each site carries its own point',
  params: { operator: 'operator name', status: STATUSES, bbox: 'xmin,ymin,xmax,ymax' },
  async fetch({ now, src, params = {} }) {
    const source = src('osm-data-centers');
    const t = dataCenterTable();
    const op = params.operator ? String(params.operator).trim().toLowerCase() : null;
    const status = params.status ? String(params.status).toLowerCase() : 'all';
    if (!STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
    let b = null;
    if (params.bbox) {
      b = String(params.bbox).split(',').map(Number);
      if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3]) throw bad('bbox must be xmin,ymin,xmax,ymax in degrees');
    }
    const out = [];
    for (const s of t.all) {
      if (op && !String(s.operator || '').toLowerCase().includes(op)) continue;
      if (status !== 'all' && s.status !== status) continue;
      if (b && !(s.lng >= b[0] && s.lng <= b[2] && s.lat >= b[1] && s.lat <= b[3])) continue;
      const where = [s.city, s.region, s.country].filter(Boolean).join(', ');
      const name = s.name || (s.operator ? `${s.operator} data center` : 'Data center');
      out.push(reading({
        source, id: s.osm_id, at: t.built, metric: 'data_center',
        place: { id: `osm-${s.osm_id.replace('/', '-')}`, name, lat: s.lat, lng: s.lng },
        value: null, unit: null,
        summary: `${name}${s.operator && !name.includes(s.operator) ? ` (${s.operator})` : ''}${where ? `, ${where}` : ''}${s.status === 'construction' ? ': under construction' : ''}`,
        fields: { operator: s.operator, operator_raw: s.operator_raw, status: s.status, city: s.city, region: s.region, country: s.country, start_date: s.start_date, osm_id: s.osm_id, table_built: t.built },
        url: `https://www.openstreetmap.org/${s.osm_id}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
