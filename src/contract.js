/**
 * The reading: the one shape every fetcher returns and every interface serves.
 *
 *   {
 *     id:       stable per source (re-fetching the same observation gives the same id)
 *     at:       ISO date or datetime of the observation itself (not of the fetch)
 *     metric:   what was measured, e.g. 'lake_water_level', 'crop_progress'
 *     value:    number | null   (null means "reported without a number", never zero)
 *     unit:     string | null
 *     summary:  one sentence a person can read
 *     place:    { id, name, lat, lng, state? } | null
 *     forecast: true only for a modelled future value
 *     fields:   anything else the upstream said, unrenamed where possible
 *     source:   { id, name, url, fetched_at, license }
 *   }
 *
 * Provenance is not optional: a reading without source.id, source.name and
 * source.fetched_at is invalid and is never served.
 */

export const LICENSES = Object.freeze([
  'public_domain',   // US government work, CC0, PDDL
  'open',            // CC BY, ODbL, OGL and similar: reuse allowed, attribution (and sometimes share-alike) required
  'non_commercial',  // free for personal/research use only
  'restricted',      // terms forbid republishing, or need a written agreement
  'unknown',         // terms not reviewed yet
]);

/**
 * Which licences a server may republish. Public domain and open data always;
 * non-commercial only when the operator says this deployment is
 * non-commercial (OPEN_SIGNALS_NONCOMMERCIAL=1); restricted and unknown never.
 * Fetching for yourself with the CLI is not republishing and is not gated.
 */
export function servable(license, env = process.env) {
  if (license === 'public_domain' || license === 'open') return true;
  if (license === 'non_commercial') return env.OPEN_SIGNALS_NONCOMMERCIAL === '1';
  return false;
}

export function reading({ source, id, at, metric, value, unit, summary, place, forecast, fields, url, fetchedAt }) {
  const v = value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    id: `${source.id}:${id}`,
    at,
    metric,
    value: v,
    unit: unit ?? null,
    summary,
    // A place we cannot put on a map (an ad-hoc region code with no coordinates) is left off, not guessed.
    place: place && Number.isFinite(place.lat) && Number.isFinite(place.lng) ? placeRef(place) : null,
    ...(forecast ? { forecast: true } : {}),
    fields: fields ?? {},
    source: { id: source.id, name: source.name, url: url ?? source.homepage ?? null, fetched_at: fetchedAt, license: source.license },
  };
}

export const placeRef = (p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, ...(p.state ? { state: p.state } : {}) });

/** Problems with a reading, as strings; [] when it is valid. */
export function validateReading(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  for (const k of ['id', 'at', 'metric', 'summary']) if (typeof r[k] !== 'string' || !r[k]) errs.push(`${k} missing`);
  if (r.value !== null && typeof r.value !== 'number') errs.push('value must be a number or null');
  if (!r.source?.id || !r.source?.name || !r.source?.fetched_at) errs.push('source.id, source.name and source.fetched_at are required');
  if (!LICENSES.includes(r.source?.license)) errs.push(`source.license must be one of ${LICENSES.join(', ')}`);
  if (r.place && !(Number.isFinite(r.place.lat) && Number.isFinite(r.place.lng))) errs.push('place needs numeric lat and lng');
  return errs;
}
