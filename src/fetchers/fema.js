/**
 * OpenFEMA disaster declarations of the last 90 days, one reading per designated area, placed at the
 * county's Census internal point (catalog/county-centroids.json), or at a point for the state when a
 * declaration names no county (statewide, tribal). Keyless; US government work.
 * Terms: https://www.fema.gov/about/openfema/terms-conditions (cite the dataset; not endorsed by FEMA).
 */

import { readFileSync } from 'node:fs';
import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

let table = null;
/** { lng, lat, state } for a five-digit county FIPS, or a two-digit state FIPS; null if unknown. */
export function fipsPoint(fips) {
  if (!table) table = JSON.parse(readFileSync(new URL('../../catalog/county-centroids.json', import.meta.url), 'utf8'));
  const f = String(fips || '');
  if (/^\d{5}$/.test(f)) { const c = table.counties[f]; return c ? { lng: c[0], lat: c[1] } : null; }
  if (/^\d{2}$/.test(f)) { const s = table.states[f]; return s ? { lng: s[0], lat: s[1], state: s[2] } : null; }
  return null;
}

const TYPE = { DR: { rank: 3, label: 'Major disaster' }, EM: { rank: 2, label: 'Emergency' }, FM: { rank: 1, label: 'Fire management' } };
const DAYS = 90;

export const openfema = {
  source: 'openfema',
  metrics: ['disaster_declaration'],
  places: 'none needed: each declared area is placed at its county (or state) point',
  async fetch({ fetch: f, now, src }) {
    const source = src('openfema');
    const since = `${localDate(new Date(now.getTime() - DAYS * 86400e3), 'UTC')}T00:00:00.000Z`;
    const url = `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${encodeURIComponent(`declarationDate ge '${since}'`)}&$orderby=${encodeURIComponent('declarationDate desc')}&$top=1000`;
    const data = await getJson(f, url, {}, 60000);
    const out = [];
    for (const d of data.DisasterDeclarationsSummaries || []) {
      const st = String(d.fipsStateCode || '').padStart(2, '0');
      const co = String(d.fipsCountyCode || '').padStart(3, '0');
      const county = co !== '000' ? fipsPoint(st + co) : null;
      const pt = county || fipsPoint(st);
      const area = d.designatedArea || (county ? 'county' : 'Statewide');
      const type = TYPE[d.declarationType] || { rank: null, label: d.declarationType };
      out.push(reading({
        source, id: `${d.femaDeclarationString}:${d.placeCode || st + co}`, at: d.declarationDate, metric: 'disaster_declaration',
        place: pt ? { id: county ? `fips-${st}${co}` : `fips-${st}`, name: `${area}, ${d.state}`, lat: pt.lat, lng: pt.lng, state: d.state } : null,
        value: type.rank, unit: 'declaration type (3 major disaster, 2 emergency, 1 fire management)',
        summary: `${d.femaDeclarationString}: ${type.label} declaration for ${d.declarationTitle ? titleCase(d.declarationTitle) : d.incidentType} (${d.incidentType}), ${area}, ${d.state}, declared ${String(d.declarationDate).slice(0, 10)}`,
        fields: { declaration: d.femaDeclarationString, disaster_number: d.disasterNumber, declaration_type: d.declarationType, incident_type: d.incidentType,
          title: d.declarationTitle ?? null, designated_area: d.designatedArea ?? null, state: d.state, county_fips: co !== '000' ? st + co : null, placed_at: county ? 'county' : pt ? 'state' : null,
          incident_begin: d.incidentBeginDate ?? null, incident_end: d.incidentEndDate ?? null, programs: ['ih', 'ia', 'pa', 'hm'].filter((k) => d[`${k}ProgramDeclared`]),
          tribal_request: !!d.tribalRequest, region: d.region ?? null },
        url: `https://www.fema.gov/disaster/${d.disasterNumber}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
