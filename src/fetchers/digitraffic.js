/**
 * Fintraffic Digitraffic AIS: ship positions in Finnish waters and the northern Baltic, from Finland's
 * coastal AIS receivers. Keyless (gzip required; a Digitraffic-User header is asked for). CC BY 4.0:
 * "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY". https://www.digitraffic.fi/en/terms-of-service/
 *
 * Positions are joined to the vessel list for name, type and destination. Pleasure craft and sailing
 * vessels (AIS ship types 36 and 37) are private people's boats and are dropped, as LADD aircraft are.
 *   params.type  all (default) | cargo | tanker | passenger | fishing | tug | other
 *   params.bbox  xmin,ymin,xmax,ymax
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';

const HEADERS = { 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'open-signals' };
const PRIVATE = new Set([36, 37]);
export const TYPES = ['all', 'cargo', 'tanker', 'passenger', 'fishing', 'tug', 'other'];
// AIS (ITU-R M.1371) ship type codes, first digit and the special 30s/50s
export function shipKind(t) {
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t === 30) return 'fishing';
  if (t === 31 || t === 32 || t === 52) return 'tug';
  return 'other';
}
// AIS navigational status
const NAV = { 0: 'under way using engine', 1: 'at anchor', 2: 'not under command', 3: 'restricted manoeuvrability', 4: 'constrained by draught', 5: 'moored', 6: 'aground', 7: 'fishing', 8: 'under way sailing', 15: 'not defined' };

function bbox(v) {
  if (v == null || v === '') return null;
  const b = String(v).split(',').map(Number);
  if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || b[0] >= b[2] || b[1] >= b[3]) throw Object.assign(new Error('bbox must be xmin,ymin,xmax,ymax in degrees'), { status: 400 });
  return b;
}

export const digitrafficAis = {
  source: 'digitraffic-ais',
  metrics: ['ship'],
  places: 'none needed: each ship carries its position (Finnish waters and the northern Baltic)',
  params: { type: TYPES, bbox: 'xmin,ymin,xmax,ymax' },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('digitraffic-ais');
    const want = TYPES.includes(params.type) ? params.type : 'all';
    const b = bbox(params.bbox);
    const [locs, vessels] = await Promise.all([
      getJson(f, 'https://meri.digitraffic.fi/api/ais/v1/locations', { headers: HEADERS }, 30000),
      getJson(f, 'https://meri.digitraffic.fi/api/ais/v1/vessels', { headers: HEADERS }, 30000),
    ]);
    const meta = new Map((Array.isArray(vessels) ? vessels : []).map((v) => [v.mmsi, v]));
    const out = [];
    let dropped = 0;
    for (const ft of locs.features || []) {
      const p = ft.properties || {};
      const [lng, lat] = ft.geometry?.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !p.mmsi) continue;
      if (b && !(lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3])) continue;
      const v = meta.get(p.mmsi) || {};
      if (PRIVATE.has(v.shipType)) { dropped += 1; continue; }
      const kind = Number.isFinite(v.shipType) ? shipKind(v.shipType) : 'other';
      if (want !== 'all' && kind !== want) continue;
      const at = new Date(p.timestampExternal || now.getTime()).toISOString();
      const name = (v.name || '').trim() || `MMSI ${p.mmsi}`;
      const sog = Number.isFinite(p.sog) && p.sog < 102.3 ? p.sog : null; // 102.3 = not available
      out.push(reading({
        source, id: `${p.mmsi}:${at.slice(0, 16)}`, at, metric: 'ship',
        place: { id: `mmsi-${p.mmsi}`, name, lat, lng },
        value: sog, unit: 'knots over ground',
        summary: `${name} (${kind}${v.destination ? `, bound for ${String(v.destination).trim()}` : ''}): ${NAV[p.navStat] ?? 'status unknown'}${sog != null ? `, ${sog} kn` : ''}`,
        fields: { mmsi: p.mmsi, imo: v.imo || null, call_sign: v.callSign || null, ship_type: v.shipType ?? null, kind, destination: v.destination ? String(v.destination).trim() : null,
          draught_m: Number.isFinite(v.draught) ? v.draught / 10 : null, course_deg: p.cog ?? null, heading_deg: p.heading === 511 ? null : p.heading ?? null, nav_status: NAV[p.navStat] ?? null },
        url: `https://www.digitraffic.fi/en/marine-traffic/`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out, ...(dropped ? { detail: `${dropped} pleasure and sailing craft left out` } : {}) };
  },
};
