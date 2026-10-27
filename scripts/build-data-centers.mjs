#!/usr/bin/env node
/**
 * Build catalog/data-centers.json: every data center mapped in OpenStreetMap (telecom=data_center,
 * building=data_center, or construction=data_center), with name, operator and status, from Overpass.
 *
 *   node scripts/build-data-centers.mjs                      # asks the Overpass mirrors below in turn
 *   node scripts/build-data-centers.mjs dump.json            # or reads a saved Overpass answer
 *   node scripts/build-data-centers.mjs --out /data/x.json   # writes elsewhere (the weekly rebuild on a server)
 *
 * The query, in eight tiles because the public mirrors refuse one worldwide query on a busy day, takes 10 to 40 minutes, too long to run per request, so the table is built ahead
 * and rebuilt on a schedule. OpenStreetMap data is ODbL 1.0: this file is a derived database and is offered
 * under ODbL 1.0 too, © OpenStreetMap contributors. Operator names are normalised for the common spellings
 * (AWS, Amazon Web Services) and kept as written in `operator_raw`.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const MIRRORS = ['https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// The world in tiles: one worldwide query is heavy enough that the public mirrors answer 502/504 on a busy day.
const TILES = [[-60, -180, 85, -100], [-60, -100, 85, -80], [-60, -80, 85, -40], [-60, -40, 85, 0], [-60, 0, 85, 15], [-60, 15, 85, 40], [-60, 40, 85, 100], [-60, 100, 85, 180]];
const query = ([s, w, n, e]) => `[out:json][timeout:240][bbox:${s},${w},${n},${e}];(nwr["telecom"="data_center"];nwr["building"="data_center"];nwr["construction"="data_center"];);out center tags;`;
const UA = 'open-signals (+https://github.com/Civops-Platform/open-signals)';
const OPERATORS = [
  [/^(aws|amazon( web services)?|amazon data services)/i, 'Amazon Web Services'], [/^microsoft/i, 'Microsoft'], [/^google/i, 'Google'], [/^(meta|facebook)/i, 'Meta'],
  [/^oracle/i, 'Oracle'], [/^equinix/i, 'Equinix'], [/^digital realty/i, 'Digital Realty'], [/^ntt/i, 'NTT'], [/^(qts|quality technology)/i, 'QTS'],
  [/^cyrusone/i, 'CyrusOne'], [/^vantage/i, 'Vantage Data Centers'], [/^coresite/i, 'CoreSite'], [/^stack/i, 'STACK Infrastructure'], [/^switch/i, 'Switch'],
  [/^iron mountain/i, 'Iron Mountain'], [/^edgeconnex/i, 'EdgeConneX'], [/^aligned/i, 'Aligned Data Centers'], [/^coreweave/i, 'CoreWeave'], [/^apple/i, 'Apple'],
];
const norm = (s) => { if (!s) return null; for (const [re, n] of OPERATORS) if (re.test(s.trim())) return n; return s.trim(); };

async function ask(q) {
  for (let round = 0; round < 3; round++) {
    for (const u of MIRRORS) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(300000) });
        const t = await r.text();
        // A query that runs out of time still answers 200, with what it had and a "runtime error" remark:
        // a short tile, not a failure, unless it is caught here.
        const j = r.ok && t.startsWith('{') ? JSON.parse(t) : null;
        if (j && !/error/i.test(j.remark || '')) return j;
        console.error(`${u}: ${r.status}${j?.remark ? ` (${j.remark.slice(0, 120)})` : ''}`);
      } catch (e) { console.error(`${u}: ${e.message}`); }
    }
    await new Promise((ok) => setTimeout(ok, 30000 * (round + 1)));
  }
  throw new Error('no Overpass mirror answered');
}

/** Every tile, one at a time, merged and de-duplicated (a way on a tile edge comes back twice). */
async function overpass() {
  const seen = new Map();
  for (const t of TILES) {
    const d = await ask(query(t));
    for (const e of d.elements || []) seen.set(`${e.type}/${e.id}`, e);
    console.error(`tile ${t.join(',')}: ${(d.elements || []).length}`);
  }
  return JSON.stringify({ elements: [...seen.values()] });
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const d = JSON.parse(args[0] ? readFileSync(args[0], 'utf8') : await overpass());
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
const target = out || new URL('../catalog/data-centers.json', import.meta.url);
if (sites.length < 1000) throw new Error(`only ${sites.length} sites: Overpass answered short, keeping the last table`);
writeFileSync(`${target}.tmp`, JSON.stringify({
  about: 'Data centers mapped in OpenStreetMap (telecom=data_center, building=data_center, construction=data_center), with normalised operator. Derived from OpenStreetMap; ODbL 1.0, © OpenStreetMap contributors. Built by scripts/build-data-centers.mjs.',
  source: 'https://www.openstreetmap.org', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors', built: new Date().toISOString().slice(0, 10), fields, sites,
}));
renameSync(`${target}.tmp`, target);
console.log(`${sites.length} data centers written, ${sites.filter((s) => s[4] === 'construction').length} under construction`);
