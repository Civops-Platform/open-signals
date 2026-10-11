/**
 * GBIF: wildlife and plant observations from the last two weeks inside a bounding box, limited to
 * records licensed CC0 or CC-BY 4.0 (so they can be republished anywhere, with attribution), and to
 * records identified to species. Most are iNaturalist research-grade observations shared to GBIF.
 *
 * No observer names are carried: attribution runs through the dataset, linked from each record.
 * Coordinates are as GBIF publishes them; sensitive species are already obscured upstream.
 *   params.group  all | birds | mammals | reptiles | amphibians | insects | plants | fungi
 *   params.bbox   xmin,ymin,xmax,ymax (default: the whole world)
 *
 * GBIF answers at most 300 records a page. The first page says how many match; when there are more,
 * the remaining pages (up to MAX_RECORDS in all) are asked for at once, each with its own timeout, and
 * a page that fails is left out rather than failing the whole answer.
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

const GROUPS = { birds: 'classKey=212', mammals: 'classKey=359', reptiles: 'classKey=11592253', amphibians: 'classKey=131', insects: 'classKey=216', plants: 'kingdomKey=6', fungi: 'kingdomKey=5' };
const WORLD = [-180, -60, 180, 75];
const PAGE = 300;
export const MAX_RECORDS = 1500;

function bbox(v) {
  if (v == null || v === '') return WORLD;
  const b = String(v).split(',').map(Number);
  if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3] || Math.abs(b[0]) > 180 || Math.abs(b[2]) > 180 || Math.abs(b[1]) > 90 || Math.abs(b[3]) > 90) {
    throw Object.assign(new Error('bbox must be xmin,ymin,xmax,ymax in degrees'), { status: 400 });
  }
  return b;
}

export const gbif = {
  source: 'gbif',
  metrics: ['observation'],
  places: 'observations inside params.bbox (default: the whole world)',
  params: { group: ['all', ...Object.keys(GROUPS)], bbox: 'xmin,ymin,xmax,ymax' },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('gbif');
    const [x0, y0, x1, y1] = bbox(params.bbox);
    const from = localDate(new Date(now.getTime() - 14 * 86400000), 'UTC');
    const group = GROUPS[params.group] ? `&${GROUPS[params.group]}` : '';
    const url = `https://api.gbif.org/v1/occurrence/search?eventDate=${from},${localDate(now, 'UTC')}`
      + `&decimalLatitude=${y0},${y1}&decimalLongitude=${x0},${x1}&license=CC0_1_0&license=CC_BY_4_0`
      + `&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT${group}&limit=${PAGE}`;
    const first = await getJson(f, `${url}&offset=0`, {}, 20000);
    const total = Math.min(MAX_RECORDS, Number(first.count) || 0);
    const offsets = [];
    if (!first.endOfRecords) for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
    const more = await Promise.allSettled(offsets.map((o) => getJson(f, `${url}&offset=${o}`, {}, 20000)));
    const records = [...(first.results || []), ...more.flatMap((p) => (p.status === 'fulfilled' ? p.value.results || [] : []))];
    const seen = new Set();
    const out = [];
    for (const r of records) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      if (!r.species || !Number.isFinite(r.decimalLatitude) || !Number.isFinite(r.decimalLongitude) || !r.eventDate) continue;
      const name = r.vernacularName ? `${r.vernacularName} (${r.species})` : r.species;
      const at = String(r.eventDate).slice(0, 10);
      out.push(reading({
        source, id: String(r.key), at, metric: 'observation',
        place: { id: `gbif-${r.key}`, name, lat: r.decimalLatitude, lng: r.decimalLongitude, ...(r.stateProvince ? { state: r.stateProvince } : {}) },
        value: Number.isFinite(r.individualCount) ? r.individualCount : null, unit: 'individuals reported',
        summary: `${name}, ${r.class || r.kingdom || 'organism'}, seen ${at}${r.stateProvince ? ` in ${r.stateProvince}` : ''}`,
        fields: { species: r.species, vernacular: r.vernacularName ?? null, class: r.class ?? null, order: r.order ?? null, family: r.family ?? null, kingdom: r.kingdom ?? null,
          basis: r.basisOfRecord ?? null, record_license: /zero/.test(r.license || '') ? 'CC0' : 'CC-BY 4.0', dataset: r.datasetKey ?? null },
        url: `https://www.gbif.org/occurrence/${r.key}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
