#!/usr/bin/env node
/**
 * Build catalog/rise-reservoirs.json: every Bureau of Reclamation daily lake/reservoir storage series in
 * RISE (https://data.usbr.gov/rise/) that has reported in the last 60 days, with its location.
 *
 *   node scripts/build-rise-reservoirs.mjs
 *
 * RISE's catalogue endpoint ignores parameter filters, so this pages through all of it (about 9,000
 * items, 100 a page), keeps storage series (parameter 3, acre-feet; 47, thousand acre-feet) that are
 * observed rather than modelled, then follows each to its catalogue record and location for a name
 * and a point. Reclamation data are US government work (public domain), provisional unless noted.
 */

import { writeFileSync } from 'node:fs';

const BASE = 'https://data.usbr.gov';
const H = { accept: 'application/vnd.api+json', 'User-Agent': 'open-signals (+https://github.com/Civops-Platform/open-signals)' };
const STORAGE = { 3: 'af', 47: 'taf' };
const get = async (path) => {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}${path}`, { headers: H, signal: AbortSignal.timeout(60000) });
    if (r.ok) return r.json();
    await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
  }
  throw new Error(`RISE ${path} failed`);
};

const since = new Date(Date.now() - 60 * 86400e3).toISOString();
const items = new Map();
for (let page = 1; ; page++) {
  const d = await get(`/rise/api/catalog-item?itemsPerPage=100&page=${page}`);
  for (const x of d.data) items.set(x.id, x);
  if (!d.links?.next) break;
}
const storage = [...items.values()].filter((x) => {
  const p = x.relationships?.parameter?.data;
  const a = x.attributes;
  return p && !Array.isArray(p) && STORAGE[p.id.split('/').pop()] && !a.isModeled && (a.temporalEndDate || '') >= since;
});
console.log(`${items.size} catalogue items, ${storage.length} current observed storage series`);

const reservoirs = [];
for (const x of storage) {
  const rec = await get(x.relationships.catalogRecord.data.id);
  const loc = await get(rec.data.relationships.location.data.id);
  const a = loc.data.attributes;
  const c = typeof a.locationCoordinates === 'string' ? JSON.parse(a.locationCoordinates.replace(/'/g, '"')) : a.locationCoordinates;
  const [lng, lat] = c?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const regions = typeof a.locationUnifiedRegionNames === 'string' ? JSON.parse(a.locationUnifiedRegionNames.replace(/'/g, '"')) : a.locationUnifiedRegionNames;
  reservoirs.push({ item_id: x.attributes._id, location_id: Number(a._id), name: a.locationName, lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5,
    unit: STORAGE[x.relationships.parameter.data.id.split('/').pop()], type: a.locationTypeName || null, region: regions?.[0] || null, source_code: x.attributes.sourceCode });
}
reservoirs.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(new URL('../catalog/rise-reservoirs.json', import.meta.url), JSON.stringify({
  about: 'Bureau of Reclamation daily lake/reservoir storage series in RISE that reported within 60 days of the build, with location. US government work (public domain); provisional unless noted. Built by scripts/build-rise-reservoirs.mjs.',
  source: 'https://data.usbr.gov/rise/', built: new Date().toISOString().slice(0, 10), reservoirs,
}, null, 0));
console.log(`${reservoirs.length} reservoirs written`);
