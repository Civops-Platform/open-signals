/**
 * National Weather Service active alerts (watches, warnings, advisories, statements) from api.weather.gov.
 * Keyless; NWS data are open data, free to use for any purpose (https://www.weather.gov/documentation/services-web-api).
 *
 * Most alerts name forecast zones and carry no polygon. Every land alert also lists its counties as SAME
 * codes (PSSCCC), so one reading is made per alert per county, at the county's Census internal point.
 * Marine alerts have no county; they are placed at the centre of their polygon when NWS sends one, and
 * otherwise left out and counted in `detail`.
 *   params.state  two-letter state (NWS area=), default the whole country
 *   params.kind   all (default) | warning | watch | advisory  (the event name's last word)
 *   params.event  an event name, e.g. "Red Flag Warning" (exact, case-insensitive)
 *   params.marine true keeps marine alerts (default false: land only)
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';
import { fipsPoint } from './fema.js';
import { US_STATES } from './epa-echo.js';

const KINDS = ['all', 'warning', 'watch', 'advisory'];
// NWS severity, as a number a map can colour by
const SEVERITY = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: null };

function centroid(g) {
  const ring = g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
  if (!ring?.length) return null;
  const pts = ring.slice(0, -1).length ? ring.slice(0, -1) : ring;
  return { lng: pts.reduce((a, p) => a + p[0], 0) / pts.length, lat: pts.reduce((a, p) => a + p[1], 0) / pts.length };
}

export const nwsAlerts = {
  source: 'nws-alerts',
  metrics: ['weather_alert'],
  places: 'none needed: each alert is placed at its counties (or its polygon, for marine alerts)',
  params: { state: 'two letters', kind: KINDS, event: 'NWS event name', marine: ['true', 'false'] },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('nws-alerts');
    const state = params.state ? String(params.state).toUpperCase() : null;
    if (state && !US_STATES.includes(state)) throw Object.assign(new Error('state must be a two-letter US state'), { status: 400 });
    const kind = KINDS.includes(params.kind) ? params.kind : 'all';
    const event = params.event ? String(params.event).trim().toLowerCase() : null;
    const marine = params.marine === 'true';
    const data = await getJson(f, `https://api.weather.gov/alerts/active?status=actual${state ? `&area=${state}` : ''}`, { headers: { Accept: 'application/geo+json' } }, 30000);
    const fetchedAt = now.toISOString();
    const out = [];
    let unplaced = 0, marineSkipped = 0;
    for (const ft of data.features || []) {
      const p = ft.properties || {};
      if (!p.event || (event && p.event.toLowerCase() !== event)) continue;
      if (kind !== 'all' && !p.event.toLowerCase().endsWith(kind)) continue;
      const counties = (p.geocode?.SAME || []).map((s) => String(s).padStart(6, '0').slice(1)).filter((c) => fipsPoint(c));
      if (!counties.length && !marine) { marineSkipped += 1; continue; } // no land county: a marine or offshore alert
      const c0 = centroid(ft.geometry);
      const spots = counties.length ? counties.map((c) => ({ id: `fips-${c}`, ...fipsPoint(c), county: c })) : c0 ? [{ id: `alert-${p.id}`, ...c0, county: null }] : [];
      if (!spots.length) { unplaced += 1; continue; }
      const sev = SEVERITY[p.severity] ?? null;
      for (const s of spots) {
        out.push(reading({
          source, id: `${p.id}:${s.county ?? 'area'}`, at: p.sent || p.effective || fetchedAt, metric: 'weather_alert',
          place: { id: s.id, name: s.county ? `county ${s.county}` : p.areaDesc?.split(';')[0] || 'alert area', lat: s.lat, lng: s.lng, ...(s.state ? { state: s.state } : {}) },
          value: sev, unit: 'severity (4 extreme, 3 severe, 2 moderate, 1 minor)',
          summary: p.headline || `${p.event} from ${p.senderName}`,
          fields: { event: p.event, severity: p.severity ?? null, urgency: p.urgency ?? null, certainty: p.certainty ?? null, onset: p.onset ?? null,
            ends: p.ends ?? null, expires: p.expires ?? null, sender: p.senderName ?? null, message_type: p.messageType ?? null, area: p.areaDesc ?? null,
            county_fips: s.county, alert_id: p.id },
          url: p['@id'] || ft.id || 'https://alerts.weather.gov', fetchedAt,
        }));
      }
    }
    const notes = [unplaced && `${unplaced} alerts with no county or polygon are left out`, marineSkipped && `${marineSkipped} marine or offshore alerts left out (marine=true adds those with a polygon)`].filter(Boolean);
    return { status: 'ok', readings: out, ...(notes.length ? { detail: notes.join('; ') } : {}) };
  },
};
