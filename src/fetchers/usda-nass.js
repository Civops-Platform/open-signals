/**
 * USDA NASS Crop Progress & Condition: weekly, national and by state, for corn,
 * soybeans, wheat and cotton. Quick Stats API, key in NASS_API_KEY (free).
 * Published Mondays 16:00 ET. US government work (public domain).
 *
 *   crop_progress   value = percent complete for one stage, with the 5-year
 *                   average for the same stage and week and the difference
 *   crop_condition  value = percent rated good + excellent, with the full
 *                   very poor → excellent distribution
 *
 * Without a key the run reports not_configured; before the first report of a
 * year it reports off_season. Neither is ever a quiet zero.
 * Ported from Civops-Platform/signals src/pipelines/usda/nass.js.
 */

import { reading } from '../contract.js';

export const NASS_COMMODITIES = ['CORN', 'SOYBEANS', 'WHEAT', 'COTTON'];
const LEVELS = ['NATIONAL', 'STATE'];
const API = 'https://quickstats.nass.usda.gov/api/api_GET/';

// Approximate state centroids, so a row can sit on a map; US total uses the
// geographic centre of the contiguous states.
const STATE_CENTROIDS = {
  US: [39.8, -98.6], AL: [32.8, -86.8], AR: [34.9, -92.4], AZ: [34.3, -111.7], CA: [37.2, -119.5], CO: [39.0, -105.5],
  CT: [41.6, -72.7], DE: [39.0, -75.5], FL: [28.6, -82.4], GA: [32.7, -83.4], IA: [42.1, -93.5], ID: [44.4, -114.6],
  IL: [40.0, -89.2], IN: [39.9, -86.3], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], MA: [42.3, -71.8],
  MD: [39.0, -76.8], ME: [45.4, -69.2], MI: [44.3, -85.4], MN: [46.3, -94.3], MO: [38.4, -92.5], MS: [32.7, -89.7],
  MT: [47.0, -109.6], NC: [35.6, -79.4], ND: [47.5, -100.5], NE: [41.5, -99.8], NH: [43.7, -71.6], NJ: [40.2, -74.7],
  NM: [34.4, -106.1], NV: [39.3, -116.6], NY: [42.9, -75.5], OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6],
  PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3],
  UT: [39.3, -111.7], VA: [37.5, -78.9], VT: [44.1, -72.7], WA: [47.4, -120.5], WI: [44.6, -89.9], WV: [38.6, -80.6],
  WY: [43.0, -107.6],
};

/** "CORN, GRAIN - PROGRESS, 5 YEAR AVG, MEASURED IN PCT HARVESTED" → { crop: 'CORN, GRAIN', stage: 'harvested' } */
export function parseShortDesc(shortDesc, unitDesc) {
  const crop = String(shortDesc || '').split(' - ')[0].trim();
  const stage = String(unitDesc || '').replace(/^PCT\s+/i, '').trim().toLowerCase();
  return { crop, stage };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function quickStats(f, key, params) {
  const url = `${API}?${new URLSearchParams({ key, format: 'JSON', source_desc: 'SURVEY', ...params })}`;
  const res = await f(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  // Quick Stats answers 400 with "no data" when a query matches nothing (e.g.
  // a crop with no report yet this year). That is an empty result, not a fault.
  if (res.status === 400 && /no data/i.test(text)) return [];
  if (!res.ok) throw new Error(`${res.status} from Quick Stats: ${text.slice(0, 200)}`);
  return JSON.parse(text).data || [];
}

function where(r) {
  const st = r.agg_level_desc === 'NATIONAL' ? 'US' : r.state_alpha;
  const [lat, lng] = STATE_CENTROIDS[st] || [null, null];
  return { id: st, name: st === 'US' ? 'United States' : r.state_name ? titleCase(r.state_name) : st, lat, lng, state: st };
}
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (v) => {
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null; // "(D)" (withheld) and "(NA)" become null, never 0
};

/**
 * Build crop readings from raw Quick Stats records (progress, 5-year average and
 * condition records mixed). Exported so tests can feed canned records.
 */
export function buildCropReadings(records, now, source) {
  const avg = new Map();
  const progress = [];
  const condition = new Map();
  for (const r of records) {
    const cat = r.statisticcat_desc;
    const { crop, stage } = parseShortDesc(r.short_desc, r.unit_desc);
    const loc = where(r);
    const value = pct(r.Value);
    if (!r.week_ending || !crop || !stage) continue;
    const k = `${loc.id}|${crop}|${stage}|${r.week_ending}`;
    if (cat === 'PROGRESS, 5 YEAR AVG') avg.set(k, value);
    else if (cat === 'PROGRESS') progress.push({ k, loc, crop, stage, week: r.week_ending, value });
    else if (cat === 'CONDITION') {
      const ck = `${loc.id}|${crop}|${r.week_ending}`;
      const c = condition.get(ck) || { loc, crop, week: r.week_ending, dist: {} };
      c.dist[stage] = value;
      condition.set(ck, c);
    }
  }

  const fetchedAt = now.toISOString();
  const url = 'https://www.nass.usda.gov/Publications/National_Crop_Progress/';
  const out = [];
  for (const p of progress) {
    if (p.value == null) continue;
    const five = avg.get(p.k) ?? null;
    const diff = five == null ? null : p.value - five;
    out.push(reading({
      source, id: `${p.loc.id}:${slug(p.crop)}:${p.stage}:${p.week}`, at: p.week, metric: 'crop_progress',
      place: p.loc.lat == null ? null : p.loc, value: p.value, unit: `pct ${p.stage}`,
      summary: `${p.loc.name} ${p.crop.toLowerCase()}: ${p.value}% ${p.stage}, week ending ${p.week}`
        + (five == null ? '' : ` (5-yr avg ${five}%, ${diff >= 0 ? '+' : ''}${diff} pts)`),
      fields: { crop: p.crop, stage: p.stage, state: p.loc.id, five_year_avg: five, vs_five_year_avg: diff },
      url, fetchedAt,
    }));
  }
  for (const c of condition.values()) {
    const g = c.dist.good, e = c.dist.excellent;
    if (g == null || e == null) continue;
    out.push(reading({
      source, id: `${c.loc.id}:${slug(c.crop)}:${c.week}`, at: c.week, metric: 'crop_condition',
      place: c.loc.lat == null ? null : c.loc, value: g + e, unit: 'pct good+excellent',
      summary: `${c.loc.name} ${c.crop.toLowerCase()}: ${g + e}% good/excellent, week ending ${c.week}`,
      fields: { crop: c.crop, state: c.loc.id, distribution: c.dist },
      url, fetchedAt,
    }));
  }
  return out;
}

export const usdaNass = {
  source: 'usda-nass',
  metrics: ['crop_progress', 'crop_condition'],
  places: 'fixed: the United States and each reporting state',
  async fetch({ fetch: f, env, now, src }) {
    if (!env.NASS_API_KEY) return { status: 'not_configured', readings: [], detail: 'NASS_API_KEY is not set' };
    // NASS files a crop under its harvest year, and Quick Stats answers 403 to
    // next-year queries, so fall-planted winter wheat appears once the year turns.
    const year = String(now.getUTCFullYear());
    const records = [];
    // Sequential on purpose: Quick Stats is a shared government service.
    for (const commodity_desc of NASS_COMMODITIES) {
      for (const statisticcat_desc of ['PROGRESS', 'PROGRESS, 5 YEAR AVG', 'CONDITION']) {
        for (const agg_level_desc of LEVELS) {
          records.push(...await quickStats(f, env.NASS_API_KEY, { commodity_desc, statisticcat_desc, agg_level_desc, year }));
        }
      }
    }
    const out = buildCropReadings(records, now, src('usda-nass'));
    return { status: out.length ? 'ok' : 'off_season', readings: out, ...(out.length ? {} : { detail: `no crop progress published for ${year} yet` }) };
  },
};
