/**
 * Global sources, so the map is not only American.
 *
 *   nasa-eonet   NASA EONET natural events worldwide: storms, wildfires, volcanoes, floods, sea and
 *                lake ice, dust, landslides. The latest position of each open event. Public domain.
 *   world-bank   World Bank indicators by country, latest value, placed at the capital (the
 *                World Bank's own coordinates). CC BY 4.0: attribute the World Bank.
 *                params.indicator: gdp_growth | inflation | manufacturing | exports | fdi | unemployment
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';

export const nasaEonet = {
  source: 'nasa-eonet',
  metrics: ['natural_event'],
  places: 'none needed: each event carries its latest position',
  async fetch({ fetch: f, now, src }) {
    const source = src('nasa-eonet');
    const data = await getJson(f, 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=60', {}, 30000);
    const out = [];
    for (const e of data.events || []) {
      const g = (e.geometry || []).filter((x) => x.type === 'Point' && Array.isArray(x.coordinates)).slice(-1)[0];
      if (!g) continue;
      const [lng, lat] = g.coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const cat = (e.categories || [])[0] || {};
      out.push(reading({
        source, id: `${e.id}:${g.date}`, at: g.date, metric: 'natural_event',
        place: { id: `eonet-${e.id}`, name: e.title, lat, lng },
        value: Number.isFinite(g.magnitudeValue) ? g.magnitudeValue : null, unit: g.magnitudeUnit || null,
        summary: `${e.title} (${cat.title || 'natural event'})${Number.isFinite(g.magnitudeValue) ? `, ${g.magnitudeValue} ${g.magnitudeUnit || ''}`.trimEnd() : ''}, last placed ${String(g.date).slice(0, 10)}`,
        fields: { category: cat.id || null, category_title: cat.title || null, positions: (e.geometry || []).length, sources: (e.sources || []).map((s) => s.id) },
        url: e.link || 'https://eonet.gsfc.nasa.gov', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

export const WB_INDICATORS = {
  gdp_growth: { code: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth', unit: '% a year' },
  inflation: { code: 'FP.CPI.TOTL.ZG', label: 'Consumer price inflation', unit: '% a year' },
  manufacturing: { code: 'NV.IND.MANF.ZS', label: 'Manufacturing, value added', unit: '% of GDP' },
  exports: { code: 'NE.EXP.GNFS.ZS', label: 'Exports of goods and services', unit: '% of GDP' },
  fdi: { code: 'BX.KLT.DINV.WD.GD.ZS', label: 'Foreign direct investment, net inflows', unit: '% of GDP' },
  unemployment: { code: 'SL.UEM.TOTL.ZS', label: 'Unemployment', unit: '% of labour force' },
};

let countries = null; // iso3 -> { name, lat, lng, region, income }
async function countryTable(f) {
  if (countries) return countries;
  const d = await getJson(f, 'https://api.worldbank.org/v2/country?format=json&per_page=400', {}, 30000);
  const t = {};
  for (const c of (d[1] || [])) {
    const lat = Number(c.latitude), lng = Number(c.longitude);
    if (!c.region || c.region.id === 'NA' || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue; // aggregates have no capital
    t[c.id] = { name: c.name, lat, lng, region: c.region.value?.trim(), income: c.incomeLevel?.value };
  }
  countries = t;
  return t;
}

export const worldBank = {
  source: 'world-bank',
  metrics: Object.keys(WB_INDICATORS),
  places: 'every economy the World Bank lists, at its capital',
  params: { indicator: Object.keys(WB_INDICATORS) },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('world-bank');
    const key = WB_INDICATORS[params.indicator] ? params.indicator : 'gdp_growth';
    const ind = WB_INDICATORS[key];
    const [table, data] = await Promise.all([
      countryTable(f),
      getJson(f, `https://api.worldbank.org/v2/country/all/indicator/${ind.code}?format=json&mrnev=1&per_page=400`, {}, 30000),
    ]);
    const out = [];
    for (const r of (data[1] || [])) {
      const c = table[r.countryiso3code];
      if (!c || r.value == null) continue;
      out.push(reading({
        source, id: `${key}:${r.countryiso3code}:${r.date}`, at: `${r.date}-12-31`, metric: key,
        place: { id: `wb-${r.countryiso3code}`, name: c.name, lat: c.lat, lng: c.lng },
        value: Math.round(r.value * 100) / 100, unit: ind.unit,
        summary: `${c.name}: ${ind.label} ${(Math.round(r.value * 10) / 10).toLocaleString('en-US')} ${ind.unit} (${r.date})`,
        fields: { indicator: ind.code, label: ind.label, year: r.date, region: c.region ?? null, income: c.income ?? null },
        url: `https://data.worldbank.org/indicator/${ind.code}?locations=${r.country?.id || ''}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
