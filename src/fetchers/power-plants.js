/**
 * Global Energy Monitor's Global Integrated Power Tracker: power plants of 50 MW or more worldwide,
 * operating or under construction, from the compact copy in catalog/power-plants.json (built by
 * scripts/build-power-plants.mjs from GEM's units, rolled up to plants by project-id). No network:
 * the table changes with GEM's releases, a few times a year. CC BY 4.0, credit Global Energy Monitor.
 * https://globalenergymonitor.org/creative-commons-license
 *
 *   params.country  ISO 3166 alpha-3 (e.g. DEU); every plant there of min_mw or more
 *   params.fuel     GEM asset type: bioenergy, coal, geothermal, hydropower, nuclear, oil/gas,
 *                   utility-scale solar, wind (a plant matches on any of its fuels)
 *   params.status   operating (has operating units) | construction (has units under construction) | all
 *   params.min_mw   floor on total capacity (operating plus construction); default 1000 worldwide,
 *                   50 inside one country
 *
 * Replaces the WRI Global Power Plant Database (static since June 2021); see catalogue 'wri-gppd'.
 */

import { readFileSync } from 'node:fs';
import { reading } from '../contract.js';

let table = null;
export function powerPlantTable() {
  if (!table) table = JSON.parse(readFileSync(new URL('../../catalog/power-plants.json', import.meta.url), 'utf8'));
  return table;
}

export const FUELS = ['bioenergy', 'coal', 'geothermal', 'hydropower', 'nuclear', 'oil/gas', 'utility-scale solar', 'wind'];
const STATUSES = ['all', 'operating', 'construction'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const fmt = (n) => n.toLocaleString('en-US');

export const gemPowerPlants = {
  source: 'gem-trackers',
  metrics: ['power_plant'],
  places: 'none needed: each plant carries its own position',
  params: { country: 'ISO alpha-3', fuel: FUELS, status: STATUSES, min_mw: 'number' },
  async fetch({ now, src, params = {} }) {
    const source = src('gem-trackers');
    const country = params.country ? String(params.country).toUpperCase() : null;
    if (country && !/^[A-Z]{3}$/.test(country)) throw bad('country must be an ISO 3166 alpha-3 code, e.g. DEU');
    const fuel = params.fuel ? FUELS.find((x) => x === String(params.fuel).toLowerCase().trim()) : null;
    if (params.fuel && !fuel) throw bad(`fuel must be one of ${FUELS.join(', ')}`);
    const status = params.status ? String(params.status).toLowerCase() : 'all';
    if (!STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
    const floor = params.min_mw == null || params.min_mw === '' ? (country ? 50 : 1000) : Number(params.min_mw);
    if (!Number.isFinite(floor) || floor < 0) throw bad('min_mw must be a number');
    const t = powerPlantTable();
    const ix = Object.fromEntries(t.fields.map((k, i) => [k, i]));
    const fuelIx = fuel ? t.fuels.indexOf(fuel) : -1;
    const asOf = t.release.replace(/^(\d{4}-\d{2}).*/, '$1-01'); // GEM's release month
    const out = [];
    for (const p of t.plants) {
      const op = p[ix.operating_mw], con = p[ix.construction_mw], total = Math.round((op + con) * 10) / 10;
      if (total < floor || (country && p[ix.country] !== country)) continue;
      if (fuel && p[ix.fuel] !== fuelIx && !p[ix.other_fuels]?.includes(fuelIx)) continue;
      if ((status === 'operating' && !(op > 0)) || (status === 'construction' && !(con > 0))) continue;
      const fuels = [p[ix.fuel], ...(p[ix.other_fuels] || [])].map((i) => t.fuels[i]);
      const state = con > 0 ? (op > 0 ? 'operating, with units under construction' : 'under construction') : 'operating';
      const year = p[ix.first_unit_year];
      const name = p[ix.name];
      const cname = t.countries[p[ix.country]] ?? 'country not mapped';
      out.push(reading({
        source, id: p[ix.project_id], at: asOf, metric: 'power_plant',
        place: { id: `gem-${p[ix.project_id]}`, name, lat: p[ix.lat], lng: p[ix.lng] },
        value: total, unit: 'MW',
        summary: `${name} (${cname}): ${fuels.join(' + ')}, ${fmt(total)} MW, ${state}`
          + `${con > 0 && op > 0 ? ` (${fmt(op)} MW operating, ${fmt(con)} MW building)` : ''}${year ? `, first unit ${year}` : ''}`,
        fields: { country: p[ix.country], country_name: t.countries[p[ix.country]] ?? null, fuel: fuels[0], fuels, status: state,
          operating_mw: op, construction_mw: con, capacity_mw: total, first_unit_year: year, location_approximate: !!p[ix.location_approximate],
          gem_project_id: p[ix.project_id], release: t.release },
        url: `${t.wiki}${p[ix.wiki] ?? name.replace(/ /g, '_')}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
