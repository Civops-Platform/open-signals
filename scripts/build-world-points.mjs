#!/usr/bin/env node
/**
 * The fixed global point sets the air_quality and river_discharge layers read.
 *
 *   node scripts/build-world-points.mjs cities [ne_10m_populated_places_simple.geojson]
 *     → catalog/world-cities.json: 150 large cities, from Natural Earth populated places (public
 *       domain), largest metro population first, at most 6 per country and none within 100 km of a
 *       larger one already chosen (CAMS' global grid is about 45 km, so closer cities read the same).
 *
 *   node scripts/build-world-points.mjs rivers
 *     → catalog/world-rivers.json: the river locations below, each moved to the GloFAS cell (0.05°)
 *       with the largest mean discharge over the last 30 days near the point written here: a 5 x 5
 *       search, repeated round the best cell while it sits on the grid's edge, at most 0.25° away.
 *       The Flood API answers for "the largest river in a 5 km area", and a point a few km off the main
 *       stem otherwise reads a creek. Uses 3,000 to 5,500 location-calls, paced under Open-Meteo's limits.
 *       The 30-day mean is kept so a reviewer can see the snap found the big river.
 *
 *   node scripts/build-world-points.mjs refine
 *     → continues the climb only for locations an earlier build left on the edge of its grid.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'open-signals (+https://github.com/Civops-Platform/open-signals)';
const NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson';
const out = (f, doc) => writeFileSync(new URL(`../catalog/${f}`, import.meta.url), `${JSON.stringify(doc, null, 0).replace(/\},\{/g, '},\n{')}\n`);
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function km(a, b) {
  const R = 6371, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function cities(file) {
  const text = file ? readFileSync(file, 'utf8') : await (await fetch(NE_URL, { headers: { 'User-Agent': UA } })).text();
  const all = JSON.parse(text).features.map((f) => f.properties)
    .map((p) => ({ name: p.nameascii || p.name, country: p.adm0_a3, country_name: p.adm0name, lat: p.latitude, lng: p.longitude, pop: p.pop_max }))
    .sort((a, b) => b.pop - a.pop);
  const per = {}, picked = [];
  for (const c of all) {
    if (picked.length >= 150) break;
    if ((per[c.country] || 0) >= 6 || picked.some((o) => km(o, c) < 100)) continue;
    per[c.country] = (per[c.country] || 0) + 1;
    picked.push(c);
  }
  const ids = new Set();
  const places = picked.map((c) => {
    let id = `city-${slug(c.name)}-${c.country.toLowerCase()}`;
    while (ids.has(id)) id += '-2';
    ids.add(id);
    return { id, name: c.name, country: c.country, country_name: c.country_name, lat: r4(c.lat), lng: r4(c.lng), pop_max: c.pop };
  });
  out('world-cities.json', {
    about: 'Large cities for the air_quality layer: Natural Earth 10m populated places (public domain), largest pop_max first, at most 6 per country, none within 100 km of a larger city already chosen. Built by scripts/build-world-points.mjs cities.',
    source: 'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/', license: 'public_domain', places,
  });
  console.log(`${places.length} cities in ${Object.keys(per).length} countries`);
}

// [river, at, ISO3, lat, lng]: a gauging town or a point just above the mouth (estuary cells read the sea).
const RIVERS = [
  ['Nile', 'Cairo', 'EGY', 30.05, 31.23], ['Nile', 'Dongola', 'SDN', 19.17, 30.48], ['Nile', 'Khartoum', 'SDN', 15.65, 32.52], ['White Nile', 'Malakal', 'SSD', 9.53, 31.66],
  ['Congo', 'Kinshasa', 'COD', -4.28, 15.29], ['Congo', 'Kisangani', 'COD', 0.52, 25.19], ['Ubangi', 'Bangui', 'CAF', 4.36, 18.58], ['Kasai', 'Ilebo', 'COD', -4.32, 20.58],
  ['Niger', 'Niamey', 'NER', 13.51, 2.11], ['Niger', 'Lokoja', 'NGA', 7.80, 6.75], ['Niger', 'Bamako', 'MLI', 12.64, -8.00], ['Benue', 'Makurdi', 'NGA', 7.73, 8.53],
  ['Zambezi', 'Victoria Falls', 'ZWE', -17.92, 25.85], ['Zambezi', 'Tete', 'MOZ', -16.16, 33.59], ['Orange', 'Upington', 'ZAF', -28.45, 21.25], ['Limpopo', 'Chokwe', 'MOZ', -24.53, 33.00],
  ['Senegal', 'Bakel', 'SEN', 14.90, -12.46], ['Okavango', 'Rundu', 'NAM', -17.90, 19.77], ['Chari', "N'Djamena", 'TCD', 12.10, 15.05], ['Ogooue', 'Lambarene', 'GAB', -0.70, 10.23],
  ['Rhine', 'Lobith', 'NLD', 51.85, 6.10], ['Rhine', 'Basel', 'CHE', 47.56, 7.59], ['Rhine', 'Cologne', 'DEU', 50.94, 6.97], ['Danube', 'Vienna', 'AUT', 48.22, 16.40],
  ['Danube', 'Budapest', 'HUN', 47.50, 19.05], ['Danube', 'Belgrade', 'SRB', 44.82, 20.45], ['Danube', 'Tulcea', 'ROU', 45.20, 28.70], ['Elbe', 'Dresden', 'DEU', 51.05, 13.74],
  ['Elbe', 'Neu Darchau', 'DEU', 53.23, 10.89], ['Oder', 'Frankfurt (Oder)', 'DEU', 52.35, 14.55], ['Vistula', 'Warsaw', 'POL', 52.24, 21.03], ['Vistula', 'Tczew', 'POL', 54.09, 18.79],
  ['Seine', 'Paris', 'FRA', 48.85, 2.35], ['Loire', 'Saumur', 'FRA', 47.26, -0.08], ['Rhone', 'Beaucaire', 'FRA', 43.81, 4.64], ['Garonne', 'Tonneins', 'FRA', 44.39, 0.31],
  ['Po', 'Pontelagoscuro', 'ITA', 44.89, 11.61], ['Ebro', 'Tortosa', 'ESP', 40.81, 0.52], ['Tagus', 'Santarem', 'PRT', 39.24, -8.68], ['Thames', 'Kingston', 'GBR', 51.41, -0.31],
  ['Dnieper', 'Kyiv', 'UKR', 50.45, 30.53], ['Volga', 'Volgograd', 'RUS', 48.70, 44.52], ['Volga', 'Astrakhan', 'RUS', 46.35, 48.03], ['Don', 'Rostov-on-Don', 'RUS', 47.22, 39.71],
  ['Northern Dvina', 'Arkhangelsk', 'RUS', 64.54, 40.54], ['Pechora', 'Naryan-Mar', 'RUS', 67.64, 53.00], ['Neva', 'Saint Petersburg', 'RUS', 59.94, 30.31], ['Glomma', 'Sarpsborg', 'NOR', 59.28, 11.11],
  ['Ural', 'Atyrau', 'KAZ', 47.11, 51.88], ['Ob', 'Salekhard', 'RUS', 66.53, 66.60], ['Ob', 'Novosibirsk', 'RUS', 55.03, 82.92], ['Irtysh', 'Omsk', 'RUS', 54.98, 73.37],
  ['Yenisei', 'Igarka', 'RUS', 67.47, 86.58], ['Yenisei', 'Krasnoyarsk', 'RUS', 56.01, 92.85], ['Lena', 'Yakutsk', 'RUS', 62.03, 129.73], ['Lena', 'Kyusyur', 'RUS', 70.68, 127.37],
  ['Kolyma', 'Srednekolymsk', 'RUS', 67.45, 153.70], ['Amur', 'Khabarovsk', 'RUS', 48.48, 135.07], ['Amur', 'Komsomolsk-on-Amur', 'RUS', 50.55, 137.00], ['Yangtze', 'Datong', 'CHN', 30.77, 117.62],
  ['Yangtze', 'Wuhan', 'CHN', 30.58, 114.30], ['Yangtze', 'Yichang', 'CHN', 30.70, 111.28], ['Yellow River', 'Lanzhou', 'CHN', 36.06, 103.83], ['Yellow River', 'Huayuankou', 'CHN', 34.91, 113.65],
  ['Xi Jiang', 'Wuzhou', 'CHN', 23.48, 111.30], ['Songhua', 'Harbin', 'CHN', 45.78, 126.62], ['Mekong', 'Vientiane', 'LAO', 17.96, 102.61], ['Mekong', 'Phnom Penh', 'KHM', 11.56, 104.93],
  ['Mekong', 'Kratie', 'KHM', 12.48, 106.02], ['Irrawaddy', 'Mandalay', 'MMR', 21.98, 96.08], ['Irrawaddy', 'Pyay', 'MMR', 18.82, 95.21], ['Salween', 'Hpa-an', 'MMR', 16.89, 97.64],
  ['Chao Phraya', 'Nakhon Sawan', 'THA', 15.70, 100.14], ['Red River', 'Hanoi', 'VNM', 21.04, 105.86], ['Ganges', 'Farakka', 'IND', 24.80, 87.92], ['Ganges', 'Patna', 'IND', 25.61, 85.14],
  ['Ganges', 'Varanasi', 'IND', 25.32, 83.02], ['Brahmaputra', 'Guwahati', 'IND', 26.19, 91.75], ['Jamuna (Brahmaputra)', 'Bahadurabad', 'BGD', 25.15, 89.70], ['Padma (Ganges)', 'Hardinge Bridge', 'BGD', 24.07, 89.03],
  ['Meghna', 'Bhairab', 'BGD', 24.05, 90.98], ['Indus', 'Sukkur', 'PAK', 27.71, 68.85], ['Indus', 'Attock', 'PAK', 33.89, 72.24], ['Godavari', 'Rajahmundry', 'IND', 17.00, 81.78],
  ['Krishna', 'Vijayawada', 'IND', 16.51, 80.61], ['Narmada', 'Bharuch', 'IND', 21.71, 72.98], ['Mahanadi', 'Cuttack', 'IND', 20.47, 85.88], ['Euphrates', 'Hit', 'IRQ', 33.64, 42.83],
  ['Tigris', 'Baghdad', 'IRQ', 33.34, 44.38], ['Amu Darya', 'Termez', 'UZB', 37.22, 67.28], ['Syr Darya', 'Kyzylorda', 'KAZ', 44.85, 65.50], ['Kapuas', 'Pontianak', 'IDN', -0.03, 109.34],
  ['Mahakam', 'Samarinda', 'IDN', -0.50, 117.15], ['Sepik', 'Ambunti', 'PNG', -4.22, 142.83], ['Mississippi', 'Vicksburg', 'USA', 32.32, -90.90], ['Mississippi', 'St. Louis', 'USA', 38.63, -90.18],
  ['Missouri', 'Hermann', 'USA', 38.71, -91.44], ['Ohio', 'Metropolis', 'USA', 37.15, -88.73], ['Columbia', 'The Dalles', 'USA', 45.61, -121.17], ['Mackenzie', 'Fort Good Hope', 'CAN', 66.26, -128.63],
  ['Yukon', 'Pilot Station', 'USA', 61.93, -162.88], ['St. Lawrence', 'Quebec City', 'CAN', 46.81, -71.20], ['Fraser', 'Hope', 'CAN', 49.38, -121.44], ['Amazon', 'Obidos', 'BRA', -1.92, -55.51],
  ['Solimoes (Amazon)', 'Manacapuru', 'BRA', -3.31, -60.61], ['Negro', 'Manaus', 'BRA', -3.13, -60.03], ['Madeira', 'Porto Velho', 'BRA', -8.76, -63.91], ['Tapajos', 'Itaituba', 'BRA', -4.28, -55.98],
  ['Xingu', 'Altamira', 'BRA', -3.20, -52.21], ['Tocantins', 'Tucurui', 'BRA', -3.77, -49.67], ['Sao Francisco', 'Juazeiro', 'BRA', -9.41, -40.50], ['Parana', 'Corrientes', 'ARG', -27.47, -58.85],
  ['Parana', 'Rosario', 'ARG', -32.95, -60.63], ['Paraguay', 'Asuncion', 'PRY', -25.28, -57.65], ['Uruguay', 'Salto', 'URY', -31.39, -57.97], ['Orinoco', 'Ciudad Bolivar', 'VEN', 8.14, -63.55],
  ['Magdalena', 'Calamar', 'COL', 10.25, -74.92], ['Ucayali', 'Pucallpa', 'PER', -8.38, -74.53], ['Amazon', 'Iquitos', 'PER', -3.75, -73.24], ['Murray', 'Mildura', 'AUS', -34.18, 142.16],
  ['Clutha', 'Balclutha', 'NZL', -46.24, 169.75], ['Waikato', 'Hamilton', 'NZL', -37.79, 175.28],
];

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) }); } catch (e) { // a network blip, not an answer
      console.error(`retrying after ${e.cause?.code || e.message}`);
      await sleep(15_000);
      continue;
    }
    if (res.status === 429) { await sleep(65_000); continue; }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('no answer after four tries');
}

const STEP = 0.05, R = 2, MAX_SHIFT = 0.25, MAX_ROUNDS = 2;

/** The cell with the largest 30-day mean discharge in a 5 x 5 grid of GloFAS cells round (lat, lng). */
async function bestAround(lat, lng) {
  const grid = [];
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) grid.push({ lat: r4(lat + i * STEP), lng: r4(lng + j * STEP), edge: Math.abs(i) === R || Math.abs(j) === R });
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${grid.map((g) => g.lat).join(',')}&longitude=${grid.map((g) => g.lng).join(',')}`
    + '&daily=river_discharge&past_days=30&forecast_days=1';
  const data = await getJson(url);
  await sleep(8000); // 25 locations a request: under 200 a minute, inside 600 a minute and 5,000 an hour
  let best = null;
  (Array.isArray(data) ? data : [data]).forEach((d, k) => {
    const q = (d.daily?.river_discharge || []).filter((v) => v != null);
    const mean = q.length ? q.reduce((x, y) => x + y, 0) / q.length : -1;
    if (!best || mean > best.mean) best = { ...grid[k], mean };
  });
  return best;
}

/** Climb from the written point: while the best cell is on the edge of the grid, search round it, never more than MAX_SHIFT away. */
async function snap(lat, lng, start = null) {
  let best = start ?? await bestAround(lat, lng);
  for (let round = 1; round < MAX_ROUNDS && best.edge; round++) {
    const next = await bestAround(best.lat, best.lng);
    if (next.mean <= best.mean || Math.abs(next.lat - lat) > MAX_SHIFT || Math.abs(next.lng - lng) > MAX_SHIFT) break;
    best = next;
  }
  return best;
}

const entry = ([river, at, country, lat, lng], best) => ({ id: `river-${slug(river)}-${slug(at)}`, name: `${river} at ${at}`, river, at, country,
  lat: best.lat, lng: best.lng, requested: [lat, lng], mean_30d_m3s: Math.round(best.mean) });

function writeRivers(places) {
  out('world-rivers.json', {
    about: 'Large-river locations for the river_discharge layer: a gauging town or a point above the mouth on about a hundred of the world\'s largest rivers, each moved to the GloFAS cell with the largest 30-day mean discharge near it (a 5 x 5 search of 0.05 degree cells, repeated round the best cell while that sits on the edge, at most 0.25 degrees from the point as written). requested holds the point as written; mean_30d_m3s is that mean at build time. Built by scripts/build-world-points.mjs rivers.',
    built: new Date().toISOString().slice(0, 10), places,
  });
  console.log(`${places.length} river locations`);
}

async function rivers() {
  const places = [];
  for (const r of RIVERS) {
    const p = entry(r, await snap(r[3], r[4]));
    places.push(p);
    console.log(`${p.id}: ${p.lat},${p.lng} mean ${p.mean_30d_m3s} m³/s`);
  }
  writeRivers(places);
}

/** Continue the climb for locations a first pass left on the edge of its grid, without asking again for the rest. */
async function refine() {
  const have = new Map(JSON.parse(readFileSync(new URL('../catalog/world-rivers.json', import.meta.url), 'utf8')).places.map((p) => [p.id, p]));
  const places = [];
  for (const r of RIVERS) {
    const old = have.get(entry(r, { lat: 0, lng: 0, mean: 0 }).id);
    const onEdge = old && (Math.abs(Math.abs(old.lat - r[3]) - R * STEP) < 1e-6 || Math.abs(Math.abs(old.lng - r[4]) - R * STEP) < 1e-6);
    if (old && !onEdge) { places.push(old); continue; }
    const p = entry(r, await snap(r[3], r[4], old ? { lat: old.lat, lng: old.lng, mean: old.mean_30d_m3s, edge: true } : null));
    places.push(p);
    console.log(`${p.id}: ${old ? `${old.lat},${old.lng} ${old.mean_30d_m3s}` : 'new'} -> ${p.lat},${p.lng} mean ${p.mean_30d_m3s} m³/s`);
  }
  writeRivers(places);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'cities') await cities(arg);
else if (cmd === 'rivers') await rivers();
else if (cmd === 'refine') await refine();
else { console.error('usage: node scripts/build-world-points.mjs cities [ne.geojson] | rivers | refine'); process.exit(2); }
