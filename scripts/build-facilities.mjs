#!/usr/bin/env node
/**
 * Build catalog/facilities/<kind>.json from Global Energy Monitor trackers (CC BY 4.0,
 * https://globalenergymonitor.org/creative-commons-license), for the heat-at-facility layers:
 *
 *   node scripts/build-facilities.mjs                # every kind, downloaded
 *   node scripts/build-facilities.mjs cement x.geojson   # one kind from a copy on disk
 *
 *   steel      Global Iron and Steel Tracker (GIST)
 *   cement     Global Cement and Concrete Tracker (GCCT)
 *   chemicals  Global Chemicals Inventory (GChI)
 *   oil_gas    Global Oil and Gas Extraction Tracker (GOGET): fields, not plants
 *
 * Keeps sites that are running, mothballed or being built, with owner and parent company. GEM writes
 * individual shareholders as "natural person(s)"; those, "unknown" and "small shareholder(s)" entries are
 * dropped as carrying no company. `hot` marks the sites that make heat a satellite can see (blast furnaces
 * and DRI, clinker kilns, every chemical plant and field); the layers list only those, so a zero means
 * something. Rows are arrays (see "fields") so the files stay small.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BUCKET = 'https://publicgemdata.nyc3.digitaloceanspaces.com';
const PLACEHOLDER = /^(unknown|small shareholder\(s\)|natural person\(s\))\s*(\[|$)/i;
const orgs = (s) => (s || '').split(';').map((x) => x.trim()).filter((x) => x && !PLACEHOLDER.test(x)).join('; ') || null;
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export const KINDS = {
  steel: {
    tracker: 'Global Iron and Steel Tracker', release: '2026-09', path: 'Current_maps/gist/gist_map_2026-09.geojson',
    page: 'https://globalenergymonitor.org/projects/global-iron-and-steel-tracker/',
    keep: ['operating', 'operating pre-retirement', 'mothballed', 'construction'], radius_km: 3,
    capacity_unit: 'thousand tonnes a year',
    hot: (p) => /BF|DRI/.test(p['prod-type'] || ''),
    extra: (p) => ({ kind_detail: p['prod-type'] || null, tech: p['tech-type'] || null, capacity: num(p.capacity) }),
  },
  cement: {
    tracker: 'Global Cement and Concrete Tracker', release: '2026-07', path: 'interim_maps/gcct_map_2026-07.geojson',
    page: 'https://globalenergymonitor.org/projects/global-cement-and-concrete-tracker/',
    keep: ['operating', 'operating pre-retirement', 'mothballed', 'construction'], radius_km: 3,
    capacity_unit: 'million tonnes of cement a year',
    hot: (p) => ['integrated', 'clinker only'].includes(p['plant-type']),
    extra: (p) => ({ kind_detail: p['plant-type'] || null, tech: [p['clinker-prod-method'], p['num-kilns-exist'] && `kilns ${p['num-kilns-exist']}`].filter((x) => x && !/unknown/.test(x)).join('; ') || null, capacity: num(p.capacity) }),
  },
  chemicals: {
    tracker: 'Global Chemicals Inventory', release: '2025-11-v2', path: 'interim_maps/gchi_map_2025-11-v2.geojson',
    page: 'https://globalenergymonitor.org/projects/global-chemicals-inventory/',
    keep: ['operating', 'mothballed', 'construction'], radius_km: 3,
    capacity_unit: 'as GEM lists it (the map file gives no unit)',
    hot: () => true,
    extra: (p) => ({ kind_detail: [p['product-primary'], p['product-secondary']].filter(Boolean).join('; ') || null, tech: p.feedstock ? `feedstock ${p.feedstock}` : null, capacity: num(p.capacity) }),
  },
  oil_gas: {
    tracker: 'Global Oil and Gas Extraction Tracker', release: '2026-03', path: 'interim_maps/goget_map_2026-03.geojson',
    page: 'https://globalenergymonitor.org/projects/global-oil-gas-extraction-tracker/',
    keep: ['operating', 'mothballed', 'in-development'], radius_km: 10,
    capacity_unit: 'million barrels of oil equivalent a year',
    hot: (p) => p['location-accuracy'] !== 'country-level only',
    extra: (p) => ({ kind_detail: p.operator ? `operator ${p.operator}` : null, tech: null, capacity: num(p.capacity) }),
  },
};

const FIELDS = ['project_id', 'name', 'owner', 'parent', 'country', 'subnational', 'status', 'kind_detail', 'tech', 'capacity', 'start_year', 'lat', 'lng', 'location_exact', 'hot', 'wiki'];

async function build(kind, file) {
  const k = KINDS[kind];
  const text = file ? readFileSync(file, 'utf8') : await (await fetch(`${BUCKET}/${k.path}`)).text();
  const sites = [];
  let dropped = 0;
  for (const f of JSON.parse(text).features) {
    const p = f.properties;
    if (!k.keep.includes(p.status) || !Number.isFinite(p.Latitude) || !Number.isFinite(p.Longitude) || p['location-accuracy'] === 'country-level only') { dropped++; continue; }
    const x = k.extra(p);
    sites.push([p['project-id'], p.name, orgs(p.owner), orgs(p.parent), p['country-area1'] || null, p.subnational || null, p.status, x.kind_detail, x.tech, x.capacity,
      num(p['start-year']), Math.round(p.Latitude * 1e5) / 1e5, Math.round(p.Longitude * 1e5) / 1e5, p['location-accuracy'] === 'exact', !!k.hot(p),
      (p.url || '').replace('https://www.gem.wiki/', '') || null]);
  }
  mkdirSync(new URL('../catalog/facilities/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../catalog/facilities/${kind}.json`, import.meta.url), JSON.stringify({
    about: `${k.tracker}, release ${k.release}, from Global Energy Monitor (CC BY 4.0: Global Energy Monitor, ${k.tracker}, ${k.release}). Sites running, mothballed or being built. Built by scripts/build-facilities.mjs.`,
    kind, tracker: k.tracker, source: k.page, terms: 'https://globalenergymonitor.org/creative-commons-license', release: k.release,
    radius_km: k.radius_km, capacity_unit: k.capacity_unit, built: new Date().toISOString().slice(0, 10), wiki: 'https://www.gem.wiki/', fields: FIELDS, sites,
  }));
  console.log(`${kind}: ${sites.length} sites kept (${sites.filter((s) => s[14]).length} hot), ${dropped} left out`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [kind, file] = process.argv.slice(2);
  for (const k of kind ? [kind] : Object.keys(KINDS)) await build(k, kind ? file : undefined);
}
