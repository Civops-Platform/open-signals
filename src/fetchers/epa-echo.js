/**
 * EPA ECHO: major EPA-regulated facilities in one state, with their compliance
 * status. Keyless; US government work (public domain).
 * https://echo.epa.gov/tools/web-services
 *
 * Two calls: get_facilities runs the query and returns a query id; get_geojson
 * returns the facilities with positions. "Major" is EPA's own flag (large
 * air, water and hazardous-waste permit holders), which keeps a state to about
 * a thousand facilities rather than a hundred thousand.
 *
 * The value is quarters out of the last 12 with non-compliance. It describes
 * what EPA has recorded, not a finding about the facility today.
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR'];
const API = 'https://echodata.epa.gov/echo/echo_rest_services';

const int = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const epaEcho = {
  source: 'epa-echo',
  metrics: ['facility_compliance'],
  places: 'major regulated facilities in params.state (default OH)',
  params: { state: US_STATES },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('epa-echo');
    const state = US_STATES.includes(String(params.state).toUpperCase()) ? String(params.state).toUpperCase() : 'OH';
    const q = await getJson(f, `${API}.get_facilities?output=JSON&p_st=${state}&p_maj=Y`, {}, 60000);
    const qid = q.Results?.QueryID;
    if (!qid) throw new Error(`ECHO returned no query id: ${JSON.stringify(q.Results?.Error || q).slice(0, 200)}`);
    const gj = await getJson(f, `${API}.get_geojson?output=GEOJSON&qid=${encodeURIComponent(qid)}`, {}, 90000);
    const today = localDate(now, 'UTC');
    const out = [];
    for (const ft of gj.features || []) {
      const p = ft.properties || {};
      const [lng, lat] = ft.geometry?.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !p.RegistryID) continue;
      const qtrs = int(p.FacQtrsWithNC);
      const snc = p.FacSNCFlg === 'Y';
      out.push(reading({
        source, id: `${p.RegistryID}:${today}`, at: today, metric: 'facility_compliance',
        place: { id: `frs-${p.RegistryID}`, name: p.FacName, lat, lng, state: p.FacState },
        value: qtrs, unit: 'quarters with non-compliance (of last 12)',
        summary: `${p.FacName}, ${p.FacCity || ''} ${p.FacState || ''}: ${p.FacComplianceStatus || 'status not reported'}`
          + `${snc ? ', significant non-complier' : ''}${p.FacTotalPenalties && p.FacTotalPenalties !== '$0' ? `, penalties ${p.FacTotalPenalties} (5 yr)` : ''}`
          + `${p.FacDateLastInspection ? `; last inspected ${String(p.FacDateLastInspection).slice(0, 10)}` : ''}`,
        fields: {
          registry_id: p.RegistryID, compliance_status: p.FacComplianceStatus ?? null, significant_noncomplier: snc,
          caa_status: p.CAAComplianceStatus ?? null, cwa_status: p.CWAComplianceStatus ?? null, rcra_status: p.RCRAComplianceStatus ?? null,
          naics: p.FacNAICSCodes ?? null, sic: p.FacSICDescs ?? null, inspections_5yr: int(p.FacInspectionCount),
          last_inspection: p.FacDateLastInspection ? String(p.FacDateLastInspection).slice(0, 10) : null,
          formal_actions_5yr: int(p.FacFormalActionCount), penalties_5yr: p.FacTotalPenalties ?? null,
        },
        url: `https://echo.epa.gov/detailed-facility-report?fid=${p.RegistryID}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
