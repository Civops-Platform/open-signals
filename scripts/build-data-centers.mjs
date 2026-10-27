#!/usr/bin/env node
/**
 * Build catalog/data-centers.json: every data center mapped in OpenStreetMap (telecom=data_center,
 * building=data_center, or construction=data_center), with name, operator and status, from Overpass.
 *
 *   node scripts/build-data-centers.mjs              # asks the Overpass mirrors below in turn
 *   node scripts/build-data-centers.mjs dump.json    # or reads a saved Overpass answer
 *
 * The worldwide query takes about three minutes, too long to run per request, so the table is built ahead
 * and rebuilt on a schedule. OpenStreetMap data is ODbL 1.0: this file is a derived database and is offered
 * under ODbL 1.0 too, © OpenStreetMap contributors. Operator names are normalised for the common spellings
 * (AWS, Amazon Web Services) and kept as written in `operator_raw`.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const MIRRORS = ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const QUERY = '[out:json][timeout:300];(nwr["telecom"="data_center"];nwr["building"="data_center"];nwr["construction"="data_center"];);out center tags;';
const UA = 'open-signals (+https://github.com/Civops-Platform/open-signals)';
const OPERATORS = [
  [/^(aws|amazon( web services)?|amazon data services)/i, 'Amazon Web Services'], [/^microsoft/i, 'Microsoft'], [/^google/i, 'Google'], [/^(meta|facebook)/i, 'Meta'],
  [/^oracle/i, 'Oracle'], [/^equinix/i, 'Equinix'], [/^digital realty/i, 'Digital Realty'], [/^ntt/i, 'NTT'], [/^(qts|quality technology)/i, 'QTS'],
  [/^cyrusone/i, 'CyrusOne'], [/^vantage/i, 'Vantage Data Centers'], [/^coresite/i, 'CoreSite'], [/^stack/i, 'STACK Infrastructure'], [/^switch/i, 'Switch'],
  [/^iron mountain/i, 'Iron Mountain'], [/^edgeconnex/i, 'EdgeConneX'], [/^aligned/i, 'Aligned Data Centers'], [/^coreweave/i, 'CoreWeave'], [/^apple/i, 'Apple'],
];
const norm = (s) => { if (!s) return null; for (const [re, n] of OPERATORS) if (re.test(s.trim())) return n; return s.trim(); };

async function overpass() {
  for (const u of MIRRORS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(QUERY)}`, signal: AbortSignal.timeout(360000) });
      const t = await r.text();
      if (r.ok && t.startsWith('{')) return t;
      console.error(`${u}: ${r.status}`);
    } catch (e) { console.error(`${u}: ${e.message}`); }
  }
  throw new Error('no Overpass mirror answered');
}

const d = JSON.parse(process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await overpass());
const fields = ['osm_id', 'name', 'operator', 'operator_raw', 'status', 'city', 'region', 'country', 'lat', 'lng', 'start_date'];
const sites = [];
for (const e of d.elements || []) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const raw = t.operator || t.owner || null;
  const status = t.construction === 'data_center' || t.building === 'construction' ? 'construction' : t.disused || t['disused:telecom'] ? 'disused' : 'operating';
  sites.push([`${e.type}/${e.id}`, t.name || null, norm(raw), raw, status, t['addr:city'] || null, t['addr:state'] || t['addr:province'] || null, t['addr:country'] || null,
    Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, t.start_date || null]);
}
writeFileSync(new URL('../catalog/data-centers.json', import.meta.url), JSON.stringify({
  about: 'Data centers mapped in OpenStreetMap (telecom=data_center, building=data_center, construction=data_center), with normalised operator. Derived from OpenStreetMap; ODbL 1.0, © OpenStreetMap contributors. Built by scripts/build-data-centers.mjs.',
  source: 'https://www.openstreetmap.org', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', built: new Date().toISOString().slice(0, 10), fields, sites,
}));
console.log(`${sites.length} data centers written, ${sites.filter((s) => s[4] === 'construction').length} under construction`);
