#!/usr/bin/env node
/**
 * Build catalog/power-plants.json from Global Energy Monitor's Global Integrated Power Tracker
 * (CC BY 4.0, https://globalenergymonitor.org/creative-commons-license):
 *
 *   node scripts/build-power-plants.mjs                 # downloads the release below
 *   node scripts/build-power-plants.mjs integrated.csv  # or reads a copy already on disk
 *
 * GEM lists units (a turbine set, a solar phase). This keeps units that are operating or under
 * construction, rolls them up to plants by project-id (operating_mw, construction_mw), and keeps
 * plants of 50 MW or more in total. Countries become ISO 3166 alpha-3 through the committed table
 * scripts/gem-country-iso3.json; a name missing from it is printed and the plant kept with country
 * null. Owners are left out: GEM records some as named people. Rows are arrays (see "fields") and
 * fuels are indexes into "fuels", so the file stays small.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const RELEASE = '2026-08-v2';
const URL_CSV = `https://publicgemdata.nyc3.digitaloceanspaces.com/Current_maps/integrated-power/${RELEASE}/integrated_map_${RELEASE}.csv`;
const MIN_MW = 50;
const KEEP = new Set(['operating', 'construction']);
const FUELS = ['bioenergy', 'coal', 'geothermal', 'hydropower', 'nuclear', 'oil/gas', 'utility-scale solar', 'wind'];
const WIKI = 'https://www.gem.wiki/';

/** RFC 4180 CSV (quoted fields may hold commas, newlines and doubled quotes). */
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

const file = process.argv[2];
let text;
if (file) text = readFileSync(file, 'utf8');
else {
  const res = await fetch(URL_CSV, { headers: { 'User-Agent': 'open-signals (+https://github.com/Civops-Platform/open-signals)' } }); // gzip-encoded body; fetch decodes it
  if (!res.ok) { console.error(`${res.status} from ${URL_CSV}`); process.exit(1); }
  text = await res.text();
}
const iso = JSON.parse(readFileSync(new URL('./gem-country-iso3.json', import.meta.url), 'utf8')).names;

const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''));
const ix = Object.fromEntries(head.map((h, i) => [h, i]));
for (const k of ['asset-type', 'country-area1', 'name', 'capacity', 'status', 'start-year', 'Latitude', 'Longitude', 'location-accuracy', 'project-id', 'url']) {
  if (ix[k] == null) { console.error(`column '${k}' missing from the CSV header`); process.exit(1); }
}

const plants = new Map();
const unmapped = new Map();
const unknownFuel = new Set();
let units = 0;
for (const r of rows) {
  if (r.length < head.length || !KEEP.has(r[ix.status])) continue;
  const mw = Number(r[ix.capacity]), lat = Number(r[ix.Latitude]), lng = Number(r[ix.Longitude]);
  if (!(mw > 0)) continue;
  const fuel = r[ix['asset-type']];
  if (!FUELS.includes(fuel)) { unknownFuel.add(fuel); continue; }
  units++;
  const id = r[ix['project-id']];
  let p = plants.get(id);
  if (!p) {
    const name = r[ix['country-area1']];
    if (!iso[name]) unmapped.set(name, (unmapped.get(name) || 0) + 1);
    plants.set(id, p = { id, name: r[ix.name], country: iso[name] ?? null, op: 0, con: 0, byFuel: {}, big: -1, lat: null, lng: null, approx: false, year: null, url: r[ix.url] });
  }
  if (r[ix.status] === 'operating') {
    p.op += mw;
    const y = Number(r[ix['start-year']]);
    if (r[ix['start-year']] !== '' && Number.isFinite(y) && y > 1800 && (p.year == null || y < p.year)) p.year = Math.floor(y);
  } else p.con += mw;
  p.byFuel[fuel] = (p.byFuel[fuel] || 0) + mw;
  if (mw > p.big && Number.isFinite(lat) && Number.isFinite(lng)) { // a plant sits at its largest unit
    p.big = mw; p.lat = lat; p.lng = lng; p.approx = r[ix['location-accuracy']] !== 'exact';
  }
}

const r1 = (n) => Math.round(n * 10) / 10;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const fields = ['project_id', 'name', 'country', 'fuel', 'other_fuels', 'operating_mw', 'construction_mw', 'lat', 'lng', 'first_unit_year', 'location_approximate', 'wiki'];
const out = [];
for (const p of plants.values()) {
  if (p.op + p.con < MIN_MW || p.lat == null) continue;
  const order = Object.entries(p.byFuel).sort((a, b) => b[1] - a[1]).map(([f]) => FUELS.indexOf(f));
  // the gem.wiki page, kept only when it is not simply the plant name with underscores
  const slug = p.url?.startsWith(WIKI) ? p.url.slice(WIKI.length) : p.url || null;
  out.push([p.id, p.name, p.country, order[0], order.length > 1 ? order.slice(1) : null, r1(p.op), r1(p.con), r4(p.lat), r4(p.lng), p.year, p.approx ? 1 : 0,
    slug === p.name.replace(/ /g, '_') ? null : slug]);
}
out.sort((a, b) => (b[5] + b[6]) - (a[5] + a[6]));

const countries = {};
for (const [name, code] of Object.entries(iso)) if (out.some((p) => p[2] === code)) countries[code] = name;
const doc = {
  about: `Power plants of ${MIN_MW} MW or more (operating plus under construction) from Global Energy Monitor's Global Integrated Power Tracker, release ${RELEASE}. `
    + 'Units with status operating or construction, rolled up to plants by GEM project-id. CC BY 4.0: Global Energy Monitor, Global Integrated Power Tracker, '
    + `${RELEASE}. Built by scripts/build-power-plants.mjs.`,
  source: 'https://globalenergymonitor.org/projects/global-integrated-power-tracker/',
  terms: 'https://globalenergymonitor.org/creative-commons-license',
  release: RELEASE, built: new Date().toISOString().slice(0, 10), min_mw: MIN_MW,
  wiki: WIKI, fuels: FUELS, countries, fields, plants: out,
};
const json = JSON.stringify(doc);
writeFileSync(new URL('../catalog/power-plants.json', import.meta.url), json);
console.log(`${out.length} plants of ${MIN_MW} MW or more, from ${units} operating or construction units in ${plants.size} projects (${rows.length} rows); ${(json.length / 1e6).toFixed(2)} MB`);
if (unmapped.size) console.log(`unmapped country names (plants kept with country null): ${[...unmapped].map(([n, c]) => `${n} (${c} units)`).join(', ')}`);
else console.log('every country name mapped to ISO 3166 alpha-3');
if (unknownFuel.size) console.log(`asset types not in the fuel list, skipped: ${[...unknownFuel].join(', ')}`);
