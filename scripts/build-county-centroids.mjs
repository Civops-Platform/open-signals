#!/usr/bin/env node
/**
 * Build catalog/county-centroids.json from the US Census Bureau county Gazetteer (public domain):
 *
 *   curl -LO https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip
 *   unzip 2024_Gaz_counties_national.zip
 *   node scripts/build-county-centroids.mjs 2024_Gaz_counties_national.txt
 *
 * counties: five-digit FIPS → [lng, lat] (the Census internal point).
 * states:   two-digit FIPS → [lng, lat, USPS], the land-area-weighted mean of its counties'
 *           internal points. A point to hang a statewide record on, not a boundary centroid.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/build-county-centroids.mjs <2024_Gaz_counties_national.txt>'); process.exit(2); }

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const head = lines.shift().split('\t').map((s) => s.trim());
const col = (n) => head.indexOf(n);
const [cUsps, cGeoid, cLand, cLat, cLng] = ['USPS', 'GEOID', 'ALAND', 'INTPTLAT', 'INTPTLONG'].map(col);
const r4 = (n) => Math.round(n * 1e4) / 1e4;

const counties = {};
const sums = {};
for (const l of lines) {
  const c = l.split('\t').map((s) => s.trim());
  const lat = Number(c[cLat]), lng = Number(c[cLng]), land = Number(c[cLand]) || 0;
  if (!/^\d{5}$/.test(c[cGeoid]) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  counties[c[cGeoid]] = [r4(lng), r4(lat)];
  const s = (sums[c[cGeoid].slice(0, 2)] ??= { w: 0, lat: 0, lng: 0, usps: c[cUsps] });
  s.w += land; s.lat += lat * land; s.lng += lng * land;
}
const states = Object.fromEntries(Object.entries(sums).filter(([, s]) => s.w > 0).map(([k, s]) => [k, [r4(s.lng / s.w), r4(s.lat / s.w), s.usps]]));

const out = {
  about: 'US county internal points, and a land-weighted point per state, for placing records that give only a county or state FIPS code. US Census Bureau 2024 Gazetteer, public domain.',
  source: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip',
  states, counties,
};
writeFileSync(new URL('../catalog/county-centroids.json', import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(counties).length} counties, ${Object.keys(states).length} states`);
