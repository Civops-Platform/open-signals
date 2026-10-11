/**
 * US freight and industrial-emissions layers from federal public-domain data. All keyless.
 *
 *   usda-ams-barge        weekly downbound grain barge tonnage through seven inland-waterway locks
 *                         (USDA AMS Grain Transportation Report, from the USACE Lock Performance
 *                         Monitoring System), Socrata dataset n4pw-9ygw. The locks are placed at their
 *                         positions in the USACE lock characteristics data (BTS NTAD Waterway Locks).
 *   bts-border-crossings  BTS Border Crossing Entry Data (CBP counts), Socrata keg4-3bc2: the latest
 *                         month, one reading per port of entry, inbound trucks as the value. The
 *                         container measures were dropped from the dataset upstream, so none here.
 *   epa-tri               EPA Toxics Release Inventory basic data file for one state and the latest
 *                         published reporting year, summed per facility: total on-site releases in
 *                         pounds. The basic file carries no contact or certifying-official names.
 *   epa-campd             EPA Clean Air Markets daily emissions bulk file for one state (keyless; the
 *                         CAMPD API itself needs a key and is not used), summed per facility over the
 *                         latest month in the file; positions from the CAMPD facility file.
 */

import { reading } from '../contract.js';
import { getJson, getText } from './http.js';
import { US_STATES } from './epa-echo.js';

/** RFC 4180 CSV → array of rows (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV → objects keyed by header; `clean` rewrites each header (e.g. strips TRI's "12. " prefixes). */
function csvObjects(text, clean = (h) => h) {
  const [head, ...rest] = parseCsv(text.replace(/^﻿/, ''));
  const keys = (head || []).map((h) => clean(h.trim()));
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const pickState = (s) => (US_STATES.includes(String(s || '').toUpperCase()) ? String(s).toUpperCase() : 'OH');

/** Try newest year first; a 403/404 means the file for that year is not published yet. */
async function latestYearText(f, urlFor, years, timeoutMs) {
  for (const y of years) {
    try { return { year: y, text: await getText(f, urlFor(y), {}, timeoutMs) }; } catch (e) {
      if (e.status === 403 || e.status === 404) continue;
      throw e;
    }
  }
  return null;
}

// ---------------------------------------------------------------- locks (USDA AMS, from USACE LPMS)

// The dataset's lock labels → the lock as USACE lists it (NDC code, name, river mile, lat, lng), read
// from the BTS NTAD Waterway Locks feature service on 2026-10-10.
export const AMS_LOCKS = {
  'MS Locks 27': { ndc: '3017938601', name: 'Chain of Rocks Lock 27', river: 'Mississippi', mile: 185.5, state: 'IL', lat: 38.70217, lng: -90.18161 },
  'MS Lock 26': { ndc: '3020090601', name: 'Mel Price Lock and Dam (26)', river: 'Mississippi', mile: 200.8, state: 'IL', lat: 38.8691, lng: -90.15063 },
  'MS Lock 25': { ndc: '3024140601', name: 'Lock and Dam 25', river: 'Mississippi', mile: 241.4, state: 'MO', lat: 39.00312, lng: -90.68921 },
  'MS Lock 15': { ndc: '3148210001', name: 'Lock and Dam 15', river: 'Mississippi', mile: 482.9, state: 'IA', lat: 41.51845, lng: -90.56445 },
  'IL La Grange': { ndc: '7708020601', name: 'LaGrange Lock and Dam', river: 'Illinois', mile: 80.2, state: 'IL', lat: 39.94507, lng: -90.53714 },
  'OH Olmsted': { ndc: 'OLMSTED', name: 'Olmsted Locks and Dam', river: 'Ohio', mile: 964.4, state: 'IL', lat: 37.18361, lng: -89.06376 },
  'AK Lock 1': { ndc: '6241041601', name: 'Norrell Lock and Dam (Arkansas Lock 1)', river: 'Arkansas (McClellan-Kerr)', mile: 10.3, state: 'AR', lat: 34.01949, lng: -91.19418 },
};
const AMS_URL = 'https://agtransport.usda.gov/resource/n4pw-9ygw.json';
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const amsBargeLocks = {
  source: 'usda-ams-barge',
  metrics: ['lock_grain_tonnage'],
  places: 'none needed: the seven locks the dataset reports, at their USACE positions',
  async fetch({ fetch: f, now, src }) {
    const source = src('usda-ams-barge');
    // 7 locks x 4 commodities x ~7 weeks; enough for the latest week and the four before it.
    const rows = await getJson(f, `${AMS_URL}?$order=${encodeURIComponent('date DESC')}&$limit=300`, {}, 30000);
    const byLock = new Map();
    for (const r of rows) {
      const d = String(r.date || '').slice(0, 10);
      if (!r.lock || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const weeks = byLock.get(r.lock) || byLock.set(r.lock, new Map()).get(r.lock);
      const w = weeks.get(d) || weeks.set(d, {}).get(d);
      w[String(r.commodity || 'other').toLowerCase()] = (w[String(r.commodity || 'other').toLowerCase()] ?? 0) + (num(r.tons) ?? 0);
    }
    const out = [];
    for (const [lock, weeks] of byLock) {
      const dates = [...weeks.keys()].sort().reverse();
      const latest = dates[0];
      const by = weeks.get(latest);
      const total = sum(Object.values(by));
      const prior = dates.slice(1, 5).map((d) => sum(Object.values(weeks.get(d))));
      const avg4 = prior.length ? Math.round(sum(prior) / prior.length) : null;
      const L = AMS_LOCKS[lock];
      const name = L ? L.name : lock;
      out.push(reading({
        source, id: `${slugify(lock)}:${latest}`, at: latest, metric: 'lock_grain_tonnage',
        place: L ? { id: `usace-lock-${L.ndc}`, name, lat: L.lat, lng: L.lng, state: L.state } : null,
        value: total, unit: 'short tons of grain, downbound, week',
        summary: `${name} (${L ? `${L.river} River mile ${L.mile}` : lock}): ${total.toLocaleString('en-US')} tons of grain downbound in the week ending ${latest}`
          + `${avg4 != null ? ` (previous four weeks averaged ${avg4.toLocaleString('en-US')})` : ''}`,
        fields: { lock_label: lock, week_ending: latest, corn: by.corn ?? null, soybeans: by.soybeans ?? null, wheat: by.wheat ?? null, other: by.other ?? null,
          prior_4wk_avg_tons: avg4, river: L?.river ?? null, river_mile: L?.mile ?? null, usace_ndc_code: L?.ndc ?? null, upstream_origin: 'USACE Lock Performance Monitoring System' },
        url: 'https://agtransport.usda.gov/d/n4pw-9ygw', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- border crossings (BTS / CBP)

const BTS_URL = 'https://data.bts.gov/resource/keg4-3bc2.json';
const measureKey = (m) => String(m).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const btsBorderCrossings = {
  source: 'bts-border-crossings',
  metrics: ['border_crossings'],
  places: 'none needed: every US-Canada and US-Mexico port of entry, at its BTS position',
  params: { border: ['all', 'canada', 'mexico'] },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('bts-border-crossings');
    const [m] = await getJson(f, `${BTS_URL}?$select=${encodeURIComponent('max(date)')}`, {}, 30000);
    const month = String(m?.max_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-01$/.test(month)) throw new Error(`BTS returned no latest month: ${JSON.stringify(m).slice(0, 200)}`);
    const border = { canada: 'US-Canada Border', mexico: 'US-Mexico Border' }[params.border];
    const where = `date='${month}T00:00:00.000'${border ? ` AND border='${border}'` : ''}`;
    const rows = await getJson(f, `${BTS_URL}?$where=${encodeURIComponent(where)}&$limit=5000`, {}, 60000);
    const ports = new Map();
    for (const r of rows) {
      const key = `${r.port_code}`;
      const p = ports.get(key) || ports.set(key, { r, m: {} }).get(key);
      p.m[measureKey(r.measure)] = (p.m[measureKey(r.measure)] ?? 0) + (num(r.value) ?? 0);
    }
    const out = [];
    for (const [code, { r, m: ms }] of ports) {
      const lat = num(r.latitude), lng = num(r.longitude);
      const trucks = ms.trucks ?? null; // BTS publishes no row for a measure a port did not report
      const side = r.border === 'US-Mexico Border' ? 'Mexico' : 'Canada';
      out.push(reading({
        source, id: `${code}:${month.slice(0, 7)}`, at: month, metric: 'border_crossings',
        place: lat != null && lng != null ? { id: `bts-port-${code}`, name: `${r.port_name}, ${r.state}`, lat, lng } : null,
        value: trucks, unit: 'inbound trucks, month',
        summary: `${r.port_name}, ${r.state} (${side} border), ${month.slice(0, 7)}: ${trucks == null ? 'no trucks reported' : `${trucks.toLocaleString('en-US')} inbound trucks`}`
          + `${ms.trains ? `, ${ms.trains.toLocaleString('en-US')} trains` : ''}${ms.personal_vehicles ? `, ${ms.personal_vehicles.toLocaleString('en-US')} personal vehicles` : ''}`,
        fields: { port_code: code, port_name: r.port_name, state: r.state, border: r.border, month: month.slice(0, 7), ...ms },
        url: 'https://data.bts.gov/Research-and-Statistics/Border-Crossing-Entry-Data/keg4-3bc2', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- Toxics Release Inventory (EPA)

const TRI_URL = (year, st) => `https://data.epa.gov/efservice/downloads/tri/mv_tri_basic_download/${year}_${st}/csv`;

export const epaTri = {
  source: 'epa-tri',
  metrics: ['toxic_release'],
  places: 'every TRI-reporting facility in params.state (default OH)',
  params: { state: US_STATES },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('epa-tri');
    const st = pickState(params.state);
    const y = now.getUTCFullYear();
    const got = await latestYearText(f, (yr) => TRI_URL(yr, st), [y - 1, y - 2, y - 3], 120000);
    if (!got) return { status: 'ok', readings: [], detail: `no TRI basic data file for ${st} in ${y - 3}-${y - 1}` };
    const forms = csvObjects(got.text, (h) => h.replace(/^\d+\.\s*/, ''));
    const fac = new Map();
    for (const r of forms) {
      if (!r.TRIFD) continue;
      const x = fac.get(r.TRIFD) || fac.set(r.TRIFD, { r, lb: 0, g: 0, chems: [], carcinogen: false, pfas: false }).get(r.TRIFD);
      const onsite = num(r['ON-SITE RELEASE TOTAL']) ?? 0;
      if (r['UNIT OF MEASURE'] === 'Grams') x.g += onsite; else x.lb += onsite; // dioxins are reported in grams
      x.chems.push({ chemical: r.CHEMICAL, onsite, unit: r['UNIT OF MEASURE'] === 'Grams' ? 'g' : 'lb' });
      if (r.CARCINOGEN === 'YES') x.carcinogen = true;
      if (r.PFAS === 'YES') x.pfas = true;
    }
    const at = `${got.year}-12-31`;
    const out = [];
    for (const [id, x] of fac) {
      const r = x.r;
      const lat = num(r.LATITUDE), lng = num(r.LONGITUDE);
      const top = x.chems.filter((c) => c.unit === 'lb' && c.onsite > 0).sort((a, b) => b.onsite - a.onsite).slice(0, 3);
      const lb = round(x.lb, 1);
      out.push(reading({
        source, id: `${id}:${got.year}`, at, metric: 'toxic_release',
        place: lat != null && lng != null && (lat !== 0 || lng !== 0) ? { id: `tri-${id}`, name: r['FACILITY NAME'], lat, lng, state: r.ST } : null,
        value: lb, unit: 'lb released on site, reporting year',
        summary: `${r['FACILITY NAME']}, ${r.CITY}, ${r.ST}: ${lb.toLocaleString('en-US')} lb of TRI chemicals released on site in ${got.year}`
          + `${top.length ? ` (most: ${top.map((c) => `${c.chemical} ${round(c.onsite, 0).toLocaleString('en-US')} lb`).join('; ')})` : ''}`
          + `${x.g ? `, plus ${round(x.g, 3)} g of dioxin-like compounds` : ''}`,
        fields: { tri_facility_id: id, frs_id: r['FRS ID'] || null, reporting_year: got.year, city: r.CITY, county: r.COUNTY, industry_sector: r['INDUSTRY SECTOR'] || null,
          naics: r['PRIMARY NAICS'] || null, parent_company: r['STANDARD PARENT CO NAME'] || r['PARENT CO NAME'] || null, federal_facility: r['FEDERAL FACILITY'] === 'YES',
          forms: x.chems.length, dioxin_grams: x.g ? round(x.g, 4) : 0, carcinogen_reported: x.carcinogen, pfas_reported: x.pfas,
          top_chemicals: top.map((c) => ({ chemical: c.chemical, lb: round(c.onsite, 1) })) },
        url: r['FRS ID'] ? `https://echo.epa.gov/detailed-facility-report?fid=${r['FRS ID']}` : 'https://www.epa.gov/toxics-release-inventory-tri-program/tri-basic-data-files-calendar-years-1987-present', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- Clean Air Markets (EPA CAMPD)

const CAMPD_BULK = 'https://api.epa.gov/easey/bulk-files';

export const epaCampd = {
  source: 'epa-campd',
  metrics: ['power_emissions'],
  places: 'every Clean Air Markets unit-reporting facility in params.state (default OH)',
  params: { state: US_STATES },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('epa-campd');
    const st = pickState(params.state);
    const y = now.getUTCFullYear();
    const daily = await latestYearText(f, (yr) => `${CAMPD_BULK}/emissions/daily/state/emissions-daily-${yr}-${st.toLowerCase()}.csv`, [y, y - 1, y - 2], 180000);
    if (!daily) return { status: 'ok', readings: [], detail: `no CAMPD daily file for ${st} in ${y - 2}-${y}` };
    const facText = await latestYearText(f, (yr) => `${CAMPD_BULK}/facility/facility-${yr}.csv`, [daily.year, daily.year - 1], 120000);
    const where = new Map();
    for (const r of facText ? csvObjects(facText.text) : []) {
      if (r.State !== st || where.has(r['Facility ID'])) continue;
      const lat = num(r.Latitude), lng = num(r.Longitude);
      if (lat != null && lng != null) where.set(r['Facility ID'], { lat, lng, county: r.County || null, owner: r['Owner/Operator'] || null, category: r['Source Category'] || null });
    }
    const rows = csvObjects(daily.text);
    const lastDate = rows.reduce((m, r) => (r.Date > m ? r.Date : m), '');
    const month = lastDate.slice(0, 7);
    const fac = new Map();
    for (const r of rows) {
      const x = fac.get(r['Facility ID']) || fac.set(r['Facility ID'], { name: r['Facility Name'], units: new Set(), fuels: new Set(), m: { co2: 0, so2: 0, nox: 0, mwh: 0, mmbtu: 0 }, ytd: { co2: 0, so2: 0, nox: 0, mwh: 0 }, last: '' }).get(r['Facility ID']);
      x.units.add(r['Unit ID']);
      if (r['Primary Fuel Type']) x.fuels.add(r['Primary Fuel Type']);
      const v = { co2: num(r['CO2 Mass (short tons)']), so2: num(r['SO2 Mass (short tons)']), nox: num(r['NOx Mass (short tons)']), mwh: num(r['Gross Load (MWh)']), mmbtu: num(r['Heat Input (mmBtu)']) };
      for (const k of ['co2', 'so2', 'nox', 'mwh']) x.ytd[k] += v[k] ?? 0;
      if (r.Date.startsWith(month)) { for (const k of Object.keys(x.m)) x.m[k] += v[k] ?? 0; if (r.Date > x.last) x.last = r.Date; }
    }
    const out = [];
    for (const [id, x] of fac) {
      const p = where.get(id);
      const co2 = round(x.m.co2, 1);
      out.push(reading({
        source, id: `${id}:${month}`, at: lastDate, metric: 'power_emissions',
        place: p ? { id: `campd-${id}`, name: x.name, lat: p.lat, lng: p.lng, state: st } : null,
        value: co2, unit: 'short tons CO2, month',
        summary: `${x.name}, ${st} (${[...x.fuels].join(', ') || 'fuel not reported'}): ${co2.toLocaleString('en-US')} short tons CO2, ${round(x.m.so2, 1)} SO2, ${round(x.m.nox, 1)} NOx and ${Math.round(x.m.mwh).toLocaleString('en-US')} MWh gross in ${month}`,
        fields: { facility_id: id, month, units: x.units.size, primary_fuels: [...x.fuels], so2_tons: round(x.m.so2, 3), nox_tons: round(x.m.nox, 3), gross_load_mwh: Math.round(x.m.mwh),
          heat_input_mmbtu: Math.round(x.m.mmbtu), year: daily.year, ytd_co2_tons: round(x.ytd.co2, 1), ytd_so2_tons: round(x.ytd.so2, 1), ytd_nox_tons: round(x.ytd.nox, 1), ytd_gross_load_mwh: Math.round(x.ytd.mwh),
          county: p?.county ?? null, owner_operator: p?.owner ?? null, source_category: p?.category ?? null, operating_in_month: x.last !== '' && x.m.mmbtu > 0 },
        url: 'https://campd.epa.gov/data/bulk-data-files', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
