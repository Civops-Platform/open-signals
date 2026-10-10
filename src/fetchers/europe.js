/**
 * Eurostat short-term business statistics by country, the latest month, placed at the capital.
 *
 *   eurostat   sts_inpr_m, industrial production (mining, manufacturing and energy, NACE B-D).
 *              Keyless JSON-stat API. Reuse for commercial or non-commercial purposes is
 *              authorised provided the source is acknowledged (Commission Decision 2011/833/EU);
 *              https://ec.europa.eu/eurostat/web/main/help/copyright-notice
 *              params.indicator: industrial_production (index, 2021 = 100, seasonally and calendar
 *              adjusted) | industrial_production_yoy (% change on the same month a year earlier,
 *              calendar adjusted)
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';

export const EUROSTAT_INDICATORS = {
  industrial_production: { unit: 'I21', s_adj: 'SCA', label: 'Industrial production', unitLabel: 'index (2021 = 100)' },
  industrial_production_yoy: { unit: 'PCH_SM', s_adj: 'CA', label: 'Industrial production, change on a year earlier', unitLabel: '% on same month a year earlier' },
};

// Capitals (lat, lng) as the World Bank publishes them, keyed by Eurostat geo code (EL = Greece,
// UK = United Kingdom). Aggregates (EU27_2020, EA20 ...) have no capital and are left off the map.
const CAPITALS = {
  BE: [50.8371, 4.36761], BG: [42.7105, 23.3238], CZ: [50.0878, 14.4205], DK: [55.6763, 12.5681], DE: [52.5235, 13.4115], EE: [59.4392, 24.7586],
  IE: [53.3441, -6.26749], EL: [37.9792, 23.7166], ES: [40.4167, -3.70327], FR: [48.8566, 2.35097], HR: [45.8069, 15.9614], IT: [41.8955, 12.4823],
  CY: [35.1676, 33.3736], LV: [56.9465, 24.1048], LT: [54.6896, 25.2799], LU: [49.61, 6.1296], HU: [47.4984, 19.0408], MT: [35.9042, 14.5189],
  NL: [52.3738, 4.89095], AT: [48.2201, 16.3798], PL: [52.26, 21.02], PT: [38.7072, -9.13552], RO: [44.4479, 26.0979], SI: [46.0546, 14.5044],
  SK: [48.1484, 17.1073], FI: [60.1608, 24.9525], SE: [59.3327, 18.0645], NO: [59.9138, 10.7387], CH: [46.948, 7.44821], UK: [51.5002, -0.126236],
  BA: [43.8607, 18.4214], ME: [42.4602, 19.2595], MK: [42.0024, 21.4361], AL: [41.3317, 19.8172], RS: [44.8024, 20.4656], TR: [39.7153, 32.3606],
  UA: [50.4536, 30.5038], IS: [64.1353, -21.8952], LI: [47.1411, 9.52148], XK: [42.565, 20.926],
};
const STATUS = { p: 'provisional', e: 'estimated', b: 'break in series', c: 'confidential', d: 'definition differs', u: 'low reliability' };

/** JSON-stat 2.0 → [{ geo, time, value, status }] for a cube where every other dimension has size 1. */
export function jsonStatRows(d) {
  const dims = d.id, size = d.size;
  const gi = dims.indexOf('geo'), ti = dims.indexOf('time');
  const geos = Object.entries(d.dimension.geo.category.index).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const times = Object.entries(d.dimension.time.category.index).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const stride = dims.map((_, i) => size.slice(i + 1).reduce((a, b) => a * b, 1));
  const out = [];
  geos.forEach((geo, g) => times.forEach((time, t) => {
    const k = String(g * stride[gi] + t * stride[ti]);
    const v = d.value?.[k];
    if (v != null) out.push({ geo, time, value: v, status: d.status?.[k] ?? null });
  }));
  return out;
}

export const eurostat = {
  source: 'eurostat',
  metrics: Object.keys(EUROSTAT_INDICATORS),
  places: 'every reporting country, at its capital',
  params: { indicator: Object.keys(EUROSTAT_INDICATORS) },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('eurostat');
    const key = EUROSTAT_INDICATORS[params.indicator] ? params.indicator : 'industrial_production';
    const ind = EUROSTAT_INDICATORS[key];
    const data = await getJson(f, `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/sts_inpr_m?format=JSON&lang=EN&indic_bt=PRD&nace_r2=B-D&unit=${ind.unit}&s_adj=${ind.s_adj}&lastTimePeriod=3`, {}, 30000);
    const names = data.dimension?.geo?.category?.label || {};
    const latest = new Map();
    for (const r of jsonStatRows(data)) if (CAPITALS[r.geo] && (!latest.has(r.geo) || r.time > latest.get(r.geo).time)) latest.set(r.geo, r);
    const out = [];
    for (const [geo, r] of latest) {
      const [lat, lng] = CAPITALS[geo];
      const name = names[geo] || geo;
      out.push(reading({
        source, id: `${key}:${geo}:${r.time}`, at: `${r.time}-01`, metric: key,
        place: { id: `eurostat-${geo}`, name, lat, lng },
        value: r.value, unit: ind.unitLabel,
        summary: `${name}: ${ind.label} ${r.value} ${ind.unitLabel} (${r.time}${STATUS[r.status] ? `, ${STATUS[r.status]}` : ''})`,
        fields: { label: ind.label, dataset: 'sts_inpr_m', nace_r2: 'B-D', month: r.time, geo, status: STATUS[r.status] ?? r.status ?? null, updated: data.updated ?? null },
        url: `https://ec.europa.eu/eurostat/databrowser/view/sts_inpr_m/default/table?lang=en`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
