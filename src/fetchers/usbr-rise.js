/**
 * Bureau of Reclamation reservoir storage from RISE (https://data.usbr.gov/rise/), at the ~215 western
 * reservoirs listed in catalog/rise-reservoirs.json (built by scripts/build-rise-reservoirs.mjs). Keyless;
 * US government work (public domain); RISE marks most values provisional.
 *
 * One reading per reservoir: the latest daily storage in acre-feet (thousand-acre-feet series are scaled),
 * with the change over the previous seven days. RISE takes a comma-separated itemId list, so reservoirs are
 * asked for BATCH at a time over the last WINDOW_DAYS; a batch that fails is left out and counted.
 *   params.region  a Reclamation region name, e.g. "Missouri Basin" (default all)
 */

import { readFileSync } from 'node:fs';
import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

export const BATCH = 10;
const WINDOW_DAYS = 10;

let table = null;
export function riseReservoirs() {
  if (!table) table = JSON.parse(readFileSync(new URL('../../catalog/rise-reservoirs.json', import.meta.url), 'utf8')).reservoirs;
  return table;
}
export const REGIONS = () => [...new Set(riseReservoirs().map((r) => r.region).filter(Boolean))].sort();

async function results(f, ids, after) {
  const out = [];
  let url = `https://data.usbr.gov/rise/api/result?itemId=${ids.join(',')}&dateTime%5Bafter%5D=${after}&itemsPerPage=100&order=DESC`;
  for (let page = 0; url && page < 5; page++) {
    const d = await getJson(f, url, { headers: { Accept: 'application/vnd.api+json' } }, 30000);
    out.push(...(d.data || []).map((x) => x.attributes));
    url = d.links?.next ? `https://data.usbr.gov${d.links.next}` : null;
  }
  return out;
}

export const usbrRise = {
  source: 'usbr-rise',
  metrics: ['reservoir_storage'],
  places: 'none needed: the Reclamation reservoirs in catalog/rise-reservoirs.json',
  params: { region: 'Reclamation region name' },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('usbr-rise');
    const region = params.region ? String(params.region).trim().toLowerCase() : null;
    const list = riseReservoirs().filter((r) => !region || (r.region || '').toLowerCase() === region);
    if (region && !list.length) throw Object.assign(new Error(`region must be one of ${REGIONS().join(', ')}`), { status: 400 });
    const after = localDate(new Date(now.getTime() - WINDOW_DAYS * 86400e3), 'UTC');
    const byItem = new Map();
    let failed = 0;
    for (let i = 0; i < list.length; i += BATCH) {
      const ids = list.slice(i, i + BATCH).map((r) => r.item_id);
      try {
        for (const r of await results(f, ids, after)) (byItem.get(r.itemId) || byItem.set(r.itemId, []).get(r.itemId)).push(r);
      } catch (e) {
        if (i === 0 && list.length <= BATCH) throw e;
        failed += ids.length;
      }
    }
    if (failed === list.length && list.length) throw new Error('every RISE batch failed');
    const out = [];
    for (const r of list) {
      const rows = (byItem.get(r.item_id) || []).filter((x) => Number.isFinite(x.result)).sort((a, b) => b.dateTime.localeCompare(a.dateTime));
      if (!rows.length) continue;
      const scale = r.unit === 'taf' ? 1000 : 1;
      const latest = rows[0], t = Date.parse(latest.dateTime);
      const week = rows.find((x) => Date.parse(x.dateTime) <= t - 6.5 * 86400e3);
      const af = Math.round(latest.result * scale);
      const change = week ? Math.round((latest.result - week.result) * scale) : null;
      out.push(reading({
        source, id: `${r.item_id}:${latest.dateTime.slice(0, 10)}`, at: latest.dateTime, metric: 'reservoir_storage',
        place: { id: `usbr-${r.location_id}`, name: r.name, lat: r.lat, lng: r.lng },
        value: af, unit: 'acre-feet',
        summary: `${r.name}: ${af.toLocaleString('en-US')} acre-feet on ${latest.dateTime.slice(0, 10)}`
          + (change == null ? '' : `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toLocaleString('en-US')} in a week`) + (latest.status ? ` (${latest.status})` : ''),
        fields: { change_7d_af: change, status: latest.status ?? null, region: r.region, rise_item_id: r.item_id, rise_location_id: r.location_id },
        url: `https://data.usbr.gov/time-series/search?itemIds=${r.item_id}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out, ...(failed ? { detail: `${failed} of ${list.length} reservoirs did not answer and are left out` } : {}) };
  },
};
