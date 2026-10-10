#!/usr/bin/env node
/**
 * Build catalog/power-plants.json from the WRI Global Power Plant Database v1.3.0 (CC BY 4.0):
 *
 *   curl -L -o gppd.zip https://wri-dataportal-prod.s3.amazonaws.com/manual/global_power_plant_database_v_1_3.zip
 *   unzip gppd.zip global_power_plant_database.csv
 *   node scripts/build-power-plants.mjs global_power_plant_database.csv
 *
 * Keeps plants of 50 MW or more, and only the fields the layer serves. Rows are arrays (see
 * "fields") so the file stays small. The database is static (last release June 2021).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const MIN_MW = 50;
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/build-power-plants.mjs <global_power_plant_database.csv>'); process.exit(2); }

/** RFC 4180 CSV (quoted fields may hold commas and doubled quotes). */
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const [head, ...rows] = parseCsv(readFileSync(file, 'utf8'));
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const fields = ['gppd_idnr', 'name', 'country', 'country_long', 'primary_fuel', 'capacity_mw', 'lat', 'lng', 'commissioning_year', 'owner'];
const plants = [];
for (const r of rows) {
  const mw = Number(r[ix.capacity_mw]), lat = Number(r[ix.latitude]), lng = Number(r[ix.longitude]);
  if (!(mw >= MIN_MW) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const year = Number(r[ix.commissioning_year]);
  plants.push([r[ix.gppd_idnr], r[ix.name], r[ix.country], r[ix.country_long], r[ix.primary_fuel], Math.round(mw * 10) / 10, r4(lat), r4(lng),
    Number.isFinite(year) && year > 0 && r[ix.commissioning_year] !== '' ? Math.floor(year) : null, r[ix.owner] || null]);
}
plants.sort((a, b) => b[5] - a[5]);
const out = {
  about: `Power plants of ${MIN_MW} MW or more from the WRI Global Power Plant Database v1.3.0 (June 2021). CC BY 4.0: Global Energy Observatory, Google, KTH Royal Institute of Technology in Stockholm, Enipedia, World Resources Institute. 2018. Global Power Plant Database. Published on Resource Watch and Google Earth Engine.`,
  source: 'https://datasets.wri.org/datasets/global-power-plant-database',
  version: '1.3.0', min_mw: MIN_MW, fields, plants,
};
writeFileSync(new URL('../catalog/power-plants.json', import.meta.url), JSON.stringify(out));
console.log(`${plants.length} plants of ${rows.length} rows`);
