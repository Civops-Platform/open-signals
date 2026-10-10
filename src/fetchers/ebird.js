/**
 * eBird: waterfowl (family Anatidae) reported in a region in the last 7 days.
 *
 * Needs EBIRD_API_KEY (free, https://ebird.org/api/keygen). API terms are
 * non-commercial; sensitive species are withheld by the API and nothing here
 * tries to recover them. The taxonomy call decides what counts as waterfowl, so
 * the species list is eBird's, not a hand-kept one.
 * Ported from Civops-Platform/signals src/pipelines/waterfowl/sources.js.
 */

import { reading } from '../contract.js';
import { getJson, localDate, sleep as defaultSleep } from './http.js';

// eBird answers 429 when a key is busy. Back off rather than lose the run.
async function getJsonRetry429(f, url, init, sleep, waits = [20_000, 60_000, 120_000]) {
  for (let i = 0; ; i++) {
    try {
      return await getJson(f, url, init);
    } catch (e) {
      if (e.status !== 429 || i >= waits.length) throw e;
      await sleep(waits[i]);
    }
  }
}

export const ebird = {
  source: 'ebird',
  metrics: ['waterfowl_sightings'],
  places: 'places with refs.ebird (a region code, e.g. US-OH-095)',
  async fetch({ fetch: f, env, now, places, src, sleep = defaultSleep }) {
    if (!env.EBIRD_API_KEY) return { status: 'not_configured', readings: [], detail: 'EBIRD_API_KEY is not set' };
    const source = src('ebird');
    const tax = await getJson(f, 'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json&cat=species');
    const waterfowl = new Map(tax.filter((t) => t.familySciName === 'Anatidae').map((t) => [t.speciesCode, t.comName]));
    if (!waterfowl.size) throw new Error('eBird taxonomy returned no Anatidae species');
    const today = localDate(now);
    const out = [];
    for (const pl of places.filter((p) => p.refs?.ebird)) {
      const region = pl.refs.ebird;
      const obs = await getJsonRetry429(f, `https://api.ebird.org/v2/data/obs/${region}/recent?back=7&maxResults=10000`, {
        headers: { 'X-eBirdApiToken': env.EBIRD_API_KEY },
      }, sleep);
      // /recent returns the most recent report of each species, one record per
      // species, so the value is that report's count, never a 7-day total.
      const latest = new Map();
      for (const o of obs) {
        if (!waterfowl.has(o.speciesCode)) continue;
        const cur = latest.get(o.speciesCode);
        if (!cur || o.obsDt > cur.obsDt) latest.set(o.speciesCode, o);
      }
      for (const [code, o] of latest) {
        const name = waterfowl.get(code);
        const count = Number.isFinite(o.howMany) ? o.howMany : null;
        out.push(reading({
          source, id: `${region}:${code}:${today}`, at: today, metric: 'waterfowl_sightings', place: pl,
          value: count, unit: 'birds in latest report',
          summary: `${name}, ${pl.name}: latest report ${count ?? 'present (no count)'} at ${o.locName || o.locId}, ${o.obsDt} (within the last 7 days)`,
          fields: { species_code: code, common_name: name, region, latest_obs: o.obsDt, loc_id: o.locId, loc_name: o.locName ?? null,
            window_days: 7, meaning: 'count in the most recent single report in the region, not a total' },
          url: `https://ebird.org/region/${region}`, fetchedAt: now.toISOString(),
        }));
      }
    }
    return { status: 'ok', readings: out };
  },
};
