/**
 * SEC EDGAR full-text search: recent filings that mention a topic, one reading per filing, with the filer's
 * place in the topic's supply chain read from its SIC code. Public domain (US government work). SEC asks
 * every client for a User-Agent naming a contact; it refuses requests without one, so this source reads it
 * from SEC_USER_AGENT and answers not_configured when that is unset. https://www.sec.gov/os/accessing-edgar-data
 *
 *   params.topic  data_centers (default)
 *   params.days   look-back, 1-90 (default 30)
 *
 * A filing names a company's office, not the site it is talking about, so readings carry no place: this is
 * a feed (/v1/readings, MCP), not a map layer. Each links the exact document that matched.
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

export const TOPICS = {
  data_centers: {
    label: 'data centers',
    query: ['data center campus', 'hyperscale data center', 'AI data center', 'AI factory', 'data center development', 'megawatts of critical IT', 'data center lease', 'AI infrastructure campus']
      .map((q) => `"${q}"`).join(' OR '),
    // Not S-1/A: EDGAR's search treats a form with a slash as the whole filter and returns only that form.
    forms: '8-K,6-K,10-Q,10-K,S-1,424B4',
  },
};
const PAGE = 100;
const MAX_HITS = 500;

// Companies whose SIC code misfiles them for this chain (Vertiv is 3679, electronic components).
const ROLE_BY_TICKER = { VRT: 'power, cooling and electrical equipment', NVT: 'power, cooling and electrical equipment' };

/** Where a filer sits in the data-center supply chain, from its name, ticker and SIC code. */
export function roleOf(sic, name = '', tickers = []) {
  for (const t of tickers) if (ROLE_BY_TICKER[t]) return ROLE_BY_TICKER[t];
  const n = Number(sic);
  if (/acquisition corp|treasury corp/i.test(name) || n === 6770) return 'blank-check company (SPAC)';
  if (/data cent/i.test(name)) return 'data-center developer or operator';
  if (/bit|mining|wulf|cipher|hut 8|riot|marathon|core scientific|iren|cleanspark|galaxy|soluna/i.test(name) && [6199, 6211, 6221, 7374, 6099].includes(n)) return 'bitcoin miner or host turning to AI';
  if (n === 6798) return 'data-center landlord (REIT)';
  if ((n >= 7370 && n <= 7379) || n === 5961) return 'cloud, software or hosting';
  if (n >= 4810 && n <= 4899) return 'telecom';
  if (n >= 3670 && n <= 3679) return 'chips and components';
  if ((n >= 3400 && n <= 3699) || (n >= 3820 && n <= 3829)) return 'power, cooling and electrical equipment';
  if (n >= 4900 && n <= 4991) return 'power and utilities';
  if (n === 1311 || (n >= 1381 && n <= 1389) || (n >= 4920 && n <= 4925)) return 'oil and gas';
  if (n >= 1000 && n <= 1099) return 'mining and fuel';
  if (n >= 1500 && n <= 1799) return 'construction';
  if (n >= 6000 && n <= 6799) return 'finance';
  return 'other';
}

const ticker = (display) => (display.match(/\(([A-Z0-9., -]+)\)\s+\(CIK/) || [])[1]?.split(',').map((t) => t.trim()) || [];
const company = (display) => display.replace(/\s+\([^)]*\)\s+\(CIK \d+\)$/, '').replace(/\s+\(CIK \d+\)$/, '').trim();

export const secFilings = {
  source: 'sec-filings',
  metrics: ['filing_mention'],
  places: 'none: a filing names an office, not a site, so readings carry no place',
  params: { topic: Object.keys(TOPICS), days: '1-90' },
  async fetch({ fetch: f, env = {}, now, src, params = {} }) {
    const source = src('sec-filings');
    if (!env.SEC_USER_AGENT) return { status: 'not_configured', readings: [], detail: 'set SEC_USER_AGENT to a name and contact email; SEC refuses requests without one' };
    const topic = TOPICS[params.topic] ? params.topic : 'data_centers';
    const days = params.days == null || params.days === '' ? 30 : Number(params.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw Object.assign(new Error('days must be an integer 1-90'), { status: 400 });
    const T = TOPICS[topic];
    const start = localDate(new Date(now.getTime() - days * 86400e3), 'UTC'), end = localDate(now, 'UTC');
    const base = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(T.query)}&forms=${T.forms}&dateRange=custom&startdt=${start}&enddt=${end}`;
    const headers = { 'User-Agent': env.SEC_USER_AGENT };
    const hits = [];
    let total = 0;
    for (let from = 0; from < MAX_HITS; from += PAGE) {
      const d = await getJson(f, `${base}&from=${from}`, { headers }, 30000);
      total = d.hits?.total?.value ?? 0;
      hits.push(...(d.hits?.hits || []));
      if (hits.length >= total || !(d.hits?.hits || []).length) break;
    }
    const byFiling = new Map();
    for (const h of hits) {
      const s = h._source || {};
      if (!s.adsh || byFiling.has(s.adsh)) continue;
      byFiling.set(s.adsh, { s, file: String(h._id || '').split(':')[1] || null });
    }
    const out = [];
    for (const [adsh, { s, file }] of byFiling) {
      const display = s.display_names?.[0] || 'unknown filer';
      const name = company(display);
      const cik = String(s.ciks?.[0] || '').replace(/^0+/, '');
      const tickers = ticker(display);
      const role = roleOf(s.sics?.[0], name, tickers);
      const doc = cik && file ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${file}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`;
      out.push(reading({
        source, id: adsh, at: s.file_date, metric: 'filing_mention',
        place: null, value: null, unit: null,
        summary: `${name}${tickers.length ? ` (${tickers.join(', ')})` : ''}, ${role}: ${s.form} filed ${s.file_date} mentions ${T.label}${s.file_description ? ` (${String(s.file_description).trim().slice(0, 90)})` : ''}`,
        fields: { topic, company: name, tickers, cik, form: s.form, file_type: s.file_type ?? null, description: s.file_description ?? null, role, sic: s.sics?.[0] ?? null,
          office: s.biz_locations?.[0] ?? null, office_state: s.biz_states?.[0] ?? null, items_8k: s.items ?? null, accession: adsh },
        url: doc, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out, ...(total > MAX_HITS ? { detail: `${total} matching documents; the first ${MAX_HITS} were read` } : {}) };
  },
};
