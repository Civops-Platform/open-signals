#!/usr/bin/env node
/**
 * Build catalog/steel-plants.json from Global Energy Monitor's Global Iron and Steel Tracker
 * (CC BY 4.0, https://globalenergymonitor.org/creative-commons-license):
 *
 *   node scripts/build-steel-plants.mjs                    # downloads the release below
 *   node scripts/build-steel-plants.mjs gist_map.geojson   # or reads a copy already on disk
 *
 * Keeps plants that are operating, operating pre-retirement, mothballed or under construction, with
 * owner and parent company, production type and capacity (thousand tonnes a year). GEM already writes
 * individual shareholders as "natural person(s)"; those, "unknown" and "small shareholder(s)" entries are
 * dropped from the parent list as carrying no company. Rows are arrays (see "fields") so the file stays small.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const RELEASE = '2026-09';
const URL_GEOJSON = `https://publicgemdata.nyc3.digitaloceanspaces.com/Current_maps/gist/gist_map_${RELEASE}.geojson`;
const KEEP = new Set(['operating', 'operating pre-retirement', 'mothballed', 'construction']);
const PLACEHOLDER = /^(unknown|small shareholder\(s\)|natural person\(s\))\s*(\[|$)/i;

const orgsOnly = (s) => (s || '').split(';').map((x) => x.trim()).filter((x) => x && !PLACEHOLDER.test(x)).join('; ') || null;

const text = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await (await fetch(URL_GEOJSON)).text();
const gj = JSON.parse(text);
const fields = ['project_id', 'name', 'owner', 'parent', 'country', 'subnational', 'status', 'prod_type', 'tech', 'capacity_kt', 'start_year', 'lat', 'lng', 'location_exact', 'wiki'];
const plants = [];
let dropped = 0;
for (const f of gj.features) {
  const p = f.properties;
  if (!KEEP.has(p.status) || !Number.isFinite(p.Latitude) || !Number.isFinite(p.Longitude)) { dropped++; continue; }
  plants.push([p['project-id'], p.name, orgsOnly(p.owner), orgsOnly(p.parent), p['country-area1'] || null, p.subnational || null, p.status,
    p['prod-type'] || null, p['tech-type'] || null, Number.isFinite(p.capacity) ? Math.round(p.capacity) : null, Number(p['start-year']) || null,
    Math.round(p.Latitude * 1e5) / 1e5, Math.round(p.Longitude * 1e5) / 1e5, p['location-accuracy'] === 'exact',
    (p.url || '').replace('https://www.gem.wiki/', '') || null]);
}
const out = {
  about: `Iron and steel plants (operating, pre-retirement, mothballed or under construction) from Global Energy Monitor's Global Iron and Steel Tracker, release ${RELEASE}. Capacity in thousand tonnes a year. CC BY 4.0: Global Energy Monitor, Global Iron and Steel Tracker, ${RELEASE}. Built by scripts/build-steel-plants.mjs.`,
  source: 'https://globalenergymonitor.org/projects/global-iron-and-steel-tracker/',
  terms: 'https://globalenergymonitor.org/creative-commons-license',
  release: RELEASE, built: new Date().toISOString().slice(0, 10), wiki: 'https://www.gem.wiki/', fields, plants,
};
writeFileSync(new URL('../catalog/steel-plants.json', import.meta.url), JSON.stringify(out));
console.log(`${plants.length} plants kept, ${dropped} left out (status or no position)`);
