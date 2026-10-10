/**
 * Business events from federal records, placed by ZIP code (Census ZCTA centroids, so a point is the
 * middle of the ZIP, not the building).
 *
 *   openfda-recalls      FDA enforcement reports (food, drugs, devices), last 60 days, at the recalling
 *                        firm's ZIP. Keyless (240 requests a minute); openFDA data is public domain.
 *   usaspending-awards   new federal contract awards in the last 30 days, the 100 largest, at the place
 *                        of performance ZIP. Keyless; US government work.
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';
import { zipCentroid } from './zip.js';

const KINDS = ['food', 'drug', 'device'];
const ymd = (d) => localDate(d, 'UTC').replace(/-/g, '');
const iso = (s) => (/^\d{8}$/.test(s || '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const CLASS_RANK = { 'Class I': 3, 'Class II': 2, 'Class III': 1 };

export const openfdaRecalls = {
  source: 'openfda-recalls',
  metrics: ['recall'],
  places: 'none needed: each recall is placed at the recalling firm\'s ZIP',
  params: { kind: ['all', ...KINDS] },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('openfda-recalls');
    const kinds = KINDS.includes(params.kind) ? [params.kind] : KINDS;
    const since = ymd(new Date(now.getTime() - 60 * 86400000));
    const out = [];
    for (const kind of kinds) {
      const url = `https://api.fda.gov/${kind}/enforcement.json?search=report_date:%5B${since}+TO+${ymd(now)}%5D&sort=report_date:desc&limit=100`;
      let data;
      try { data = await getJson(f, url); } catch (e) {
        if (e.status === 404) continue; // openFDA answers 404 when nothing matches
        throw e;
      }
      for (const r of data.results || []) {
        const c = zipCentroid(r.postal_code);
        const at = iso(r.report_date);
        if (!at) continue;
        out.push(reading({
          source, id: `${kind}:${r.recall_number || r.event_id}`, at, metric: 'recall',
          place: c ? { id: `zip-${String(r.postal_code).slice(0, 5)}`, name: `${r.recalling_firm}, ${r.city}, ${r.state}`, lat: c[1], lng: c[0], state: r.state } : null,
          value: CLASS_RANK[r.classification] ?? null, unit: 'FDA class (3 = most serious)',
          summary: `${kind === 'device' ? 'Device' : kind === 'drug' ? 'Drug' : 'Food'} recall, ${r.classification}: ${r.recalling_firm} (${r.city}, ${r.state}) — ${String(r.reason_for_recall || '').slice(0, 160)}`,
          fields: { kind, classification: r.classification, status: r.status, recalling_firm: r.recalling_firm, product: String(r.product_description || '').slice(0, 300),
            reason: r.reason_for_recall, initiated: iso(r.recall_initiation_date), distribution: String(r.distribution_pattern || '').slice(0, 200), recall_number: r.recall_number },
          url: `https://www.accessdata.fda.gov/scripts/ires/index.cfm`, fetchedAt: now.toISOString(),
        }));
      }
    }
    return { status: 'ok', readings: out };
  },
};

export const usaspendingAwards = {
  source: 'usaspending',
  metrics: ['contract_award'],
  places: 'none needed: each award is placed at its place-of-performance ZIP',
  async fetch({ fetch: f, now, src }) {
    const source = src('usaspending');
    const body = {
      filters: { time_period: [{ start_date: localDate(new Date(now.getTime() - 30 * 86400000), 'UTC'), end_date: localDate(now, 'UTC'), date_type: 'new_awards_only' }], award_type_codes: ['A', 'B', 'C', 'D'] },
      fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Description', 'Start Date', 'Place of Performance Zip5', 'Place of Performance State Code', 'generated_internal_id'],
      sort: 'Award Amount', order: 'desc', limit: 100, page: 1,
    };
    const data = await getJson(f, 'https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 60000);
    const out = [];
    for (const r of data.results || []) {
      const c = zipCentroid(r['Place of Performance Zip5']);
      out.push(reading({
        source, id: r.generated_internal_id || r['Award ID'], at: r['Start Date'], metric: 'contract_award',
        place: c ? { id: `zip-${r['Place of Performance Zip5']}`, name: `Place of performance, ZIP ${r['Place of Performance Zip5']}`, lat: c[1], lng: c[0], state: r['Place of Performance State Code'] } : null,
        value: r['Award Amount'], unit: 'USD',
        summary: `${r['Awarding Agency']}${r['Awarding Sub Agency'] && r['Awarding Sub Agency'] !== r['Awarding Agency'] ? ` (${r['Awarding Sub Agency']})` : ''} awarded $${(r['Award Amount'] / 1e6).toFixed(1)}M to ${r['Recipient Name']}: ${String(r.Description || '').slice(0, 140)}`,
        fields: { recipient: r['Recipient Name'], agency: r['Awarding Agency'], sub_agency: r['Awarding Sub Agency'] ?? null, award_id: r['Award ID'], description: r.Description ?? null, state: r['Place of Performance State Code'] ?? null },
        url: r.generated_internal_id ? `https://www.usaspending.gov/award/${r.generated_internal_id}` : 'https://www.usaspending.gov', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
