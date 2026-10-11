/**
 * Smithsonian Global Volcanism Program, Volcanoes of the World (VOTW): Holocene volcanoes worldwide
 * that have erupted since a given year, and which of them are erupting now, from the GVP GeoServer WFS.
 *
 *   params.erupted_since  last known eruption in or after this year (default 1900, 1500 at the earliest)
 *   params.continuing     true keeps only volcanoes with an eruption GVP lists as continuing
 *
 * Terms (https://volcano.si.edu/gvp_termsofuse.cfm): the VOTW database is a work of US government
 * employees, offered under the Smithsonian Terms of Use for personal, educational and other
 * non-commercial use with citation; the GVP asks for "Global Volcanism Program, Smithsonian
 * Institution" with a link to https://volcano.si.edu/. Photo captions and credits are not read.
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';

const WFS = 'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=1.0.0&request=GetFeature&outputFormat=application/json';
const VOLCANO_FIELDS = ['Volcano_Number', 'Volcano_Name', 'Primary_Volcano_Type', 'Last_Eruption_Year', 'Country', 'Region', 'Subregion', 'Latitude', 'Longitude', 'Elevation', 'Tectonic_Setting', 'Evidence_Category'];
const MAX = 2000;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** GVP dates are YYYYMMDD with 00 for an unknown month or day. */
function gvpDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo === '00') return { iso: `${y}-01-01`, precision: 'year' };
  if (d === '00') return { iso: `${y}-${mo}-01`, precision: 'month' };
  return { iso: `${y}-${mo}-${d}`, precision: 'day' };
}

export const smithsonianVolcanoes = {
  source: 'smithsonian-gvp',
  metrics: ['volcano_last_eruption'],
  places: 'none needed: each volcano carries its own position',
  params: { erupted_since: 'year (1500 or later)', continuing: ['true', 'false'] },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('smithsonian-gvp');
    const since = params.erupted_since == null || params.erupted_since === '' ? 1900 : Number(params.erupted_since);
    if (!Number.isInteger(since) || since < 1500 || since > now.getUTCFullYear()) throw bad(`erupted_since must be a year from 1500 to ${now.getUTCFullYear()}`);
    const onlyContinuing = params.continuing === 'true' || params.continuing === true;
    const [volcanoes, eruptions] = await Promise.all([
      getJson(f, `${WFS}&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&maxFeatures=${MAX}&propertyName=${VOLCANO_FIELDS.join(',')}`
        + `&CQL_FILTER=${encodeURIComponent(`Last_Eruption_Year>=${since}`)}`, {}, 60000),
      getJson(f, `${WFS}&typeName=GVP-VOTW:E3WebApp_Eruptions1960&maxFeatures=${MAX}&CQL_FILTER=${encodeURIComponent("ContinuingEruption='True'")}`, {}, 60000),
    ]);
    const ongoing = new Map();
    for (const ft of eruptions.features || []) {
      const e = ft.properties || {};
      const y = Number(e.StartDateYear);
      // some long eruptions carry only a year (Yasur: 1270), which still says how long it has gone on
      const start = gvpDate(e.StartDate) ?? (Number.isInteger(y) && y > 0 ? { iso: `${String(y).padStart(4, '0')}-01-01`, precision: 'year' } : null);
      const prev = ongoing.get(e.VolcanoNumber);
      if (!prev || (start && (!prev.start || start.iso > prev.start.iso))) ongoing.set(e.VolcanoNumber, { start, vei: e.ExplosivityIndexMax ?? null });
    }
    const out = [];
    for (const ft of volcanoes.features || []) {
      const v = ft.properties || {};
      const lat = Number(v.Latitude), lng = Number(v.Longitude), year = Number(v.Last_Eruption_Year);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isInteger(year)) continue;
      const now_ = ongoing.get(v.Volcano_Number);
      if (onlyContinuing && !now_) continue;
      const at = now_?.start ?? { iso: `${year}-01-01`, precision: 'year' };
      out.push(reading({
        source, id: String(v.Volcano_Number), at: at.iso, metric: 'volcano_last_eruption',
        place: { id: `gvp-${v.Volcano_Number}`, name: v.Volcano_Name, lat, lng },
        value: year, unit: 'year of last known eruption',
        summary: `${v.Volcano_Name} (${v.Country}): ${now_ ? `erupting, continuing since ${now_.start ? (now_.start.precision === 'year' ? now_.start.iso.slice(0, 4) : now_.start.iso) : 'an unknown date'}${now_.vei != null ? `, VEI up to ${now_.vei} so far` : ''}` : `last known eruption ${year}`}`
          + `${v.Primary_Volcano_Type ? `; ${String(v.Primary_Volcano_Type).toLowerCase()}` : ''}`,
        fields: { volcano_number: v.Volcano_Number, country: v.Country ?? null, region: v.Region ?? null, subregion: v.Subregion ?? null,
          volcano_type: v.Primary_Volcano_Type ?? null, elevation_m: v.Elevation ?? null, tectonic_setting: v.Tectonic_Setting ?? null,
          evidence: v.Evidence_Category ?? null, last_eruption_year: year, continuing_eruption: !!now_, eruption_start: now_?.start?.iso ?? null,
          vei_max: now_?.vei ?? null, date_precision: at.precision },
        url: `https://volcano.si.edu/volcano.cfm?vn=${v.Volcano_Number}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
