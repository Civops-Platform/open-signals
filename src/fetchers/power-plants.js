/**
 * WRI Global Power Plant Database v1.3.0: power plants of 50 MW or more worldwide, from the compact
 * copy in catalog/power-plants.json (built by scripts/build-power-plants.mjs). No network: the
 * database is static (last release June 2021). CC BY 4.0, attribute WRI and its partners.
 * https://datasets.wri.org/datasets/global-power-plant-database
 *
 *   params.country  ISO 3166 alpha-3 (e.g. DEU); every plant there of min_mw or more
 *   params.fuel     primary fuel (Coal, Gas, Hydro, Nuclear, Solar, Wind ...)
 *   params.min_mw   capacity floor; default 1000 worldwide, 50 inside one country
 */

import { readFileSync } from 'node:fs';
import { reading } from '../contract.js';

let table = null;
export function powerPlantTable() {
  if (!table) table = JSON.parse(readFileSync(new URL('../../catalog/power-plants.json', import.meta.url), 'utf8'));
  return table;
}

export const FUELS = ['Biomass', 'Coal', 'Cogeneration', 'Gas', 'Geothermal', 'Hydro', 'Nuclear', 'Oil', 'Other', 'Petcoke', 'Solar', 'Storage', 'Waste', 'Wave and Tidal', 'Wind'];
const AS_OF = '2021-06-02'; // the v1.3.0 release; capacities are as the database recorded them then
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export const wriPowerPlants = {
  source: 'wri-gppd',
  metrics: ['power_plant'],
  places: 'none needed: each plant carries its own position',
  params: { country: 'ISO alpha-3', fuel: FUELS, min_mw: 'number' },
  async fetch({ now, src, params = {} }) {
    const source = src('wri-gppd');
    const country = params.country ? String(params.country).toUpperCase() : null;
    if (country && !/^[A-Z]{3}$/.test(country)) throw bad('country must be an ISO 3166 alpha-3 code, e.g. DEU');
    const fuel = params.fuel ? FUELS.find((x) => x.toLowerCase() === String(params.fuel).toLowerCase()) : null;
    if (params.fuel && !fuel) throw bad(`fuel must be one of ${FUELS.join(', ')}`);
    const floor = params.min_mw == null || params.min_mw === '' ? (country ? 50 : 1000) : Number(params.min_mw);
    if (!Number.isFinite(floor) || floor < 0) throw bad('min_mw must be a number');
    const t = powerPlantTable();
    const ix = Object.fromEntries(t.fields.map((k, i) => [k, i]));
    const out = [];
    for (const p of t.plants) {
      if (p[ix.capacity_mw] < floor || (country && p[ix.country] !== country) || (fuel && p[ix.primary_fuel] !== fuel)) continue;
      const year = p[ix.commissioning_year];
      out.push(reading({
        source, id: p[ix.gppd_idnr], at: AS_OF, metric: 'power_plant',
        place: { id: `gppd-${p[ix.gppd_idnr]}`, name: p[ix.name], lat: p[ix.lat], lng: p[ix.lng] },
        value: p[ix.capacity_mw], unit: 'MW',
        summary: `${p[ix.name]} (${p[ix.country_long]}): ${p[ix.primary_fuel].toLowerCase()}, ${p[ix.capacity_mw].toLocaleString('en-US')} MW${year ? `, commissioned ${year}` : ''}`,
        fields: { country: p[ix.country], country_name: p[ix.country_long], fuel: p[ix.primary_fuel], capacity_mw: p[ix.capacity_mw], commissioning_year: year,
          owner: p[ix.owner], gppd_id: p[ix.gppd_idnr], database_version: t.version },
        url: 'https://datasets.wri.org/datasets/global-power-plant-database', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
