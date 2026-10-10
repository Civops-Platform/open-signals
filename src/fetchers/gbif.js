/**
 * GBIF: wildlife and plant observations from the last two weeks inside a bounding box, limited to
 * records licensed CC0 or CC-BY 4.0 (so they can be republished anywhere, with attribution), and to
 * records identified to species. Most are iNaturalist research-grade observations shared to GBIF.
 *
 * No observer names are carried: attribution runs through the dataset, linked from each record.
 * Coordinates are as GBIF publishes them; sensitive species are already obscured upstream.
 *   params.group  all | birds | mammals | reptiles | amphibians | insects | plants | fungi
 *   params.bbox   xmin,ymin,xmax,ymax (default: the lower 48)
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

const GROUPS = { birds: 'classKey=212', mammals: 'classKey=359', reptiles: 'classKey=11592253', amphibians: 'classKey=131', insects: 'classKey=216', plants: 'kingdomKey=6', fungi: 'kingdomKey=5' };
const US48 = [-125, 24, -66, 50];

function bbox(v) {
  if (v == null || v === '') return US48;
  const b = String(v).split(',').map(Number);
  if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3] || Math.abs(b[0]) > 180 || Math.abs(b[2]) > 180 || Math.abs(b[1]) > 90 || Math.abs(b[3]) > 90) {
    throw Object.assign(new Error('bbox must be xmin,ymin,xmax,ymax in degrees'), { status: 400 });
  }
  return b;
}

export const gbif = {
  source: 'gbif',
  metrics: ['observation'],
  places: 'observations inside params.bbox (default: the lower 48)',
  params: { group: ['all', ...Object.keys(GROUPS)], bbox: 'xmin,ymin,xmax,ymax' },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('gbif');
    const [x0, y0, x1, y1] = bbox(params.bbox);
    const from = localDate(new Date(now.getTime() - 14 * 86400000), 'UTC');
    const group = GROUPS[params.group] ? `&${GROUPS[params.group]}` : '';
    const url = `https://api.gbif.org/v1/occurrence/search?eventDate=${from},${localDate(now, 'UTC')}`
      + `&decimalLatitude=${y0},${y1}&decimalLongitude=${x0},${x1}&license=CC0_1_0&license=CC_BY_4_0`
      + `&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT${group}&limit=300`;
    const data = await getJson(f, url, {}, 30000);
    const out = [];
    for (const r of data.results || []) {
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
