/**
 * What REST, MCP and the CLI share: resolve places, run a fetcher behind a
 * cache, apply the licence gate, and draw layers as GeoJSON.
 *
 * mode 'serve' republishes, so the licence gate applies (contract.servable).
 * mode 'local' is a person fetching for themselves with their own keys, so it
 * does not; the CLI prints the licence note instead.
 */

import { servable, placeRef } from './contract.js';
import { PLACES, source as catalogSource } from './catalog.js';
import { FETCHERS } from './fetchers/index.js';

import { HttpError } from './errors.js';

export { HttpError };

const MAX_ADHOC_PLACES = 10;

// Minutes a fetch result is reused. Upstreams are public services; be polite.
const TTL_MIN = {
  'open-meteo': 60, 'waterfowl-wsi': 60, 'noaa-coops': 30, 'usgs-water': 30,
  glerl: 360, ebird: 120, 'usda-nass': 360, 'usgs-earthquakes': 2,
  'usgs-volcanoes': 10, 'noaa-nwps': 15, 'epa-echo': 720, 'openfda-recalls': 360, usaspending: 360, gbif: 60, 'nasa-eonet': 30, 'world-bank': 1440,
  emsc: 2, 'noaa-ibtracs': 60, eurostat: 720, openfema: 60,
  'gem-trackers': 1440, 'open-meteo-flood': 720, 'open-meteo-air': 180, 'smithsonian-gvp': 720,
  'usda-ams-barge': 360, 'bts-border-crossings': 1440, 'epa-tri': 1440, 'epa-campd': 1440,
  'usace-mvn-locks': 30, 'nrcs-snotel': 360, 'us-drought-monitor': 720, 'noaa-spc-reports': 10, 'nifc-wfigs': 15,
  'adsb-lol': 2, 'nasa-firms': 30, 'nws-alerts': 5, 'usbr-rise': 360, corroboration: 10, 'digitraffic-ais': 1,
};

// Places a fetcher reads when the caller names none.
const WATER_BODIES = new Set(['marsh', 'bay', 'lake']);
const DEFAULT_PLACES = {
  'open-meteo': (ps) => ps.filter((p) => WATER_BODIES.has(p.kind)),
  'waterfowl-wsi': (ps) => ps.filter((p) => p.tags?.includes('waterfowl') && WATER_BODIES.has(p.kind)),
  'noaa-coops': (ps) => ps.filter((p) => p.refs?.coops),
  'usgs-water': (ps) => ps.filter((p) => p.refs?.usgs),
  ebird: (ps) => ps.filter((p) => p.refs?.ebird),
  // none from the catalogue: these read their own world lists (catalog/world-*.json) unless a caller names places
  'open-meteo-flood': () => [],
  'open-meteo-air': () => [],
  'adsb-lol': () => [], // a named lat/lng, the worldwide military list, or (gps) the fetcher's watched regions
};

/**
 * Places for a request, from (in order) ad-hoc coordinates or upstream ids,
 * named catalogue places, a tag, or the fetcher's default.
 *   q: { place: 'a,b', tag, lat, lng, name, coops, usgs, ebird }
 */
export function resolvePlaces(sourceId, q = {}, places = PLACES) {
  const adhoc = [];
  if (q.lat != null || q.lng != null) {
    const lat = Number(q.lat), lng = Number(q.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new HttpError(400, 'lat and lng must both be numbers in range');
    }
    adhoc.push({ id: `pt-${lat.toFixed(3)}_${lng.toFixed(3)}`, name: q.name || `${lat.toFixed(3)}, ${lng.toFixed(3)}`, lat, lng, refs: {} });
  }
  for (const ref of ['coops', 'usgs', 'ebird']) {
    for (const v of splitList(q[ref])) {
      if (!/^[A-Za-z0-9-]{1,40}$/.test(v)) throw new HttpError(400, `${ref} id '${v}' is not valid`);
      adhoc.push({ id: `${ref}-${v}`, name: q.name || '', lat: null, lng: null, refs: { [ref]: v } });
    }
  }
  if (adhoc.length > MAX_ADHOC_PLACES) throw new HttpError(400, `at most ${MAX_ADHOC_PLACES} ad-hoc places per request`);
  if (adhoc.length) return adhoc;

  const named = splitList(q.place);
  if (named.length) {
    const byId = new Map(places.map((p) => [p.id, p]));
    const unknown = named.filter((id) => !byId.has(id));
    if (unknown.length) throw new HttpError(404, `unknown place: ${unknown.join(', ')}`, { places: [...byId.keys()] });
    return named.map((id) => byId.get(id));
  }
  const pool = q.tag ? places.filter((p) => p.tags?.includes(q.tag)) : places;
  return (DEFAULT_PLACES[sourceId] || ((ps) => ps))(pool);
}

const splitList = (v) => (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

export function createService({ fetch: fetchFn = globalThis.fetch, env = process.env, now = () => new Date(), fetchers = FETCHERS, places = PLACES } = {}) {
  const cache = new Map();
  const cooldown = new Map(); // source id -> { until, detail } after a 429

  function gate(id, mode) {
    const s = safeSource(id);
    if (!fetchers[id]) throw new HttpError(404, `source '${id}' is catalogued but has no fetcher yet`, { fetchable: fetchableIds() });
    if (mode === 'serve' && !servable(s.license, env)) {
      throw new HttpError(451, `source '${id}' is licensed '${s.license}' and this server does not republish it: ${s.license_note}`, { license: s.license });
    }
    return s;
  }

  function fetchableIds(mode = 'local') {
    return Object.keys(fetchers).filter((id) => mode !== 'serve' || servable(safeSource(id).license, env));
  }

  /** Run one source for the resolved places; cached by source, places and params. */
  async function run(id, q = {}, { mode = 'serve' } = {}) {
    gate(id, mode);
    const f = fetchers[id];
    const ps = resolvePlaces(id, q, places);
    const params = Object.fromEntries(Object.keys(f.params || {}).filter((k) => q[k] != null).map((k) => [k, String(q[k])]));
    const key = JSON.stringify([id, ps.map((p) => p.id).sort(), params]);
    const hit = cache.get(key);
    const t = now();
    if (hit && hit.until > t.getTime()) return hit.result;
    // After an upstream refuses for rate (429), leave it alone for a while: asking again only spends
    // more of its limit and holds the caller past the proxy's timeout. The last good answer serves meanwhile.
    const stale = (detail) => (hit ? { ...hit.result, status: 'stale', stale_since: new Date(hit.until).toISOString(), detail } : null);
    const cool = cooldown.get(id);
    if (cool && cool.until > t.getTime()) {
      const s0 = stale(cool.detail); if (s0) return s0;
      throw new HttpError(503, `${id} is resting after its upstream refused for rate; try after ${new Date(cool.until).toISOString()}`, { retry_after: new Date(cool.until).toISOString() });
    }
    let result;
    try {
      result = await f.fetch({ fetch: fetchFn, env, now: t, places: ps, params, src: catalogSource });
    } catch (e) {
      // A fetcher rejecting its own parameters is the caller's error; an upstream failure is not.
      if (e.status === 400 && e.body === undefined) throw new HttpError(400, e.message);
      if (e.status === 429) cooldown.set(id, { until: t.getTime() + (/daily|day/i.test(e.message) ? 60 : 10) * 60_000, detail: e.message.slice(0, 200) });
      const s1 = stale(`upstream failed: ${e.message.slice(0, 200)}`); if (s1) return s1;
      throw e;
    }
    if (result.status === 'ok' || result.status === 'off_season') {
      cache.set(key, { until: t.getTime() + (TTL_MIN[id] ?? 30) * 60_000, result });
    }
    return result;
  }

  /** Readings for one source, filtered and newest first. */
  async function readings(id, q = {}, opts = {}) {
    const limit = q.limit == null ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'limit must be an integer 1-1000');
    if (q.since != null && Number.isNaN(Date.parse(q.since))) throw new HttpError(400, 'since must be an ISO date or datetime');
    const r = await run(id, q, opts);
    let rs = r.readings;
    if (q.metric) rs = rs.filter((x) => x.metric === q.metric);
    if (q.since) rs = rs.filter((x) => x.at >= q.since);
    if (q.forecast === 'false' || q.forecast === false) rs = rs.filter((x) => !x.forecast);
    rs = [...rs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    return { source: id, status: r.status, ...(r.detail ? { detail: r.detail } : {}), generated_at: now().toISOString(), count: rs.length, readings: rs };
  }

  async function layer(id, q = {}, opts = {}) {
    const L = LAYERS[id];
    if (!L) throw new HttpError(404, `unknown layer '${id}'`, { layers: Object.keys(LAYERS) });
    const date = q.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
    const r = await run(L.source, { ...q, ...(L.q || {}) }, opts);
    const rs = r.readings.filter((x) => (!L.metric || x.metric === L.metric) && x.place); // no metric: the source's one series (e.g. the chosen indicator)
    const s = catalogSource(L.source);
    const base = { type: 'FeatureCollection', layer: id, label: L.label, unit: L.unit, ...(L.read ? { read: L.read } : {}), status: r.status,
      source: { id: s.id, name: s.name, license: s.license, ...(s.attribution ? { attribution: s.attribution } : {}) } };
    if (L.events) {
      return { ...base, features: rs.map((x) => feature(x.place, { id: x.id, at: x.at, value: L.value(x), summary: x.summary, url: x.source.url, ...basisOf(x), ...(L.extra ? L.extra(x) : {}) })) };
    }
    const features = [];
    for (const [, group] of pickPerPlace(rs, date)) {
      const r0 = group[0];
      const props = { place: r0.place.id, name: r0.place.name, date: r0.at.slice(0, 10), forecast: !!r0.forecast, ...basisOf(r0), url: r0.source.url, fetched_at: r0.source.fetched_at };
      if (L.group) {
        props.items = group.map((x) => ({ label: x.fields.common_name ?? x.summary, value: L.value(x), summary: x.summary })).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
        props.value = props.items.length;
        props.unit = L.group;
      } else {
        props.value = L.value(r0);
        props.summary = r0.summary;
        if (L.extra) Object.assign(props, L.extra(r0));
      }
      features.push(feature(r0.place, props));
    }
    return { ...base, date, features };
  }

  function layerCatalog(mode = 'serve') {
    return Object.entries(LAYERS).map(([id, L]) => {
      const s = catalogSource(L.source);
      return { id, label: L.label, unit: L.unit, source: L.source, license: s.license, available: mode !== 'serve' || servable(s.license, env), ...(L.read ? { read: L.read } : {}) };
    });
  }

  return { run, readings, layer, layerCatalog, fetchableIds, gate };
}

function safeSource(id) {
  try { return catalogSource(id); } catch { throw new HttpError(404, `unknown source '${id}'`); }
}

const feature = (p, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { ...props, place_ref: placeRef(p) } });

/** Per place: the readings dated `date` if any, else the latest observed (not forecast) on or before it. */
export function pickPerPlace(rs, date) {
  const by = new Map();
  for (const r of rs) (by.get(r.place.id) || by.set(r.place.id, []).get(r.place.id)).push(r);
  const out = new Map();
  for (const [id, group] of by) {
    const exact = group.filter((r) => r.at.slice(0, 10) === date);
    if (exact.length) { out.set(id, exact); continue; }
    const past = group.filter((r) => r.at.slice(0, 10) <= date && !r.forecast).sort((a, b) => b.at.localeCompare(a.at));
    if (past.length) out.set(id, past.filter((r) => r.at.slice(0, 10) === past[0].at.slice(0, 10)));
  }
  return out;
}

const valueOf = (r) => r.value;
const basisOf = (r) => ({ basis: r.basis || 'observed', ...(r.derived_from ? { derived_from: r.derived_from } : {}) });
const field = (k) => (r) => (Number.isFinite(Number(r.fields?.[k])) && r.fields?.[k] !== null ? Number(r.fields[k]) : null);

export const LAYERS = {
  temperature: { label: 'Mean temperature', source: 'open-meteo', metric: 'weather_daily', unit: '°C', value: field('temp_mean_c') },
  wind: { label: 'Max wind', source: 'open-meteo', metric: 'weather_daily', unit: 'km/h', value: field('wind_max_kmh'),
    extra: (r) => ({ direction_deg: field('wind_dir_deg')(r), north_wind: !!r.fields?.north_wind }), read: 'Dominant direction in direction_deg; north_wind = from NW to NE.' },
  pressure_change: { label: 'Pressure change (day over day)', source: 'open-meteo', metric: 'weather_daily', unit: 'hPa', value: field('pressure_change_hpa'),
    read: 'A sharp rise after a fall usually marks a front passing.' },
  snow_depth: { label: 'Snow depth', source: 'open-meteo', metric: 'weather_daily', unit: 'cm', value: field('snow_depth_cm') },
  wsi: { label: 'Duck freeze index (WSI)', source: 'waterfowl-wsi', metric: 'waterfowl_wsi', unit: 'index', value: valueOf,
    read: 'Cumulative cold + snow; higher is harsher. Leave points 7.2 (mallard) and −4.6 (other dabblers) were fit in Missouri and are a prior elsewhere.' },
  water_level: { label: 'Water level', source: 'noaa-coops', metric: 'water_level', unit: 'ft above datum', value: valueOf,
    read: 'Great Lakes stations against Low Water Datum (LWD), tidal stations against Mean Lower Low Water (MLLW); each reading says which.' },
  river_flow: { label: 'River flow', source: 'usgs-water', metric: 'river_discharge', unit: 'ft³/s', value: valueOf },
  ice: { label: 'Great Lakes ice cover', source: 'glerl', metric: 'lake_ice_cover', unit: '%', value: valueOf, read: 'Lake-wide percentage, published roughly December to May.' },
  sightings: { label: 'Waterfowl sightings (eBird)', source: 'ebird', metric: 'waterfowl_sightings', unit: 'birds in latest report', value: valueOf, group: 'species reported',
    read: 'Per region: each species with the count in its latest single report. Not totals; birder effort varies.' },
  volcanoes: { label: 'US volcano alert levels', source: 'usgs-volcanoes', metric: 'volcano_alert', unit: 'alert level 0–3', value: valueOf, events: true,
    extra: (r) => ({ alert_level: r.fields.alert_level, color_code: r.fields.color_code }), read: '0 normal/green, 1 advisory/yellow, 2 watch/orange, 3 warning/red. elevated=true keeps only those above normal.' },
  flood_gauges: { label: 'River flood status (NOAA NWPS)', source: 'noaa-nwps', metric: 'river_flood_status', unit: 'stage', value: valueOf, events: true,
    extra: (r) => ({ flood_category: r.fields.flood_category, flood_rank: r.fields.flood_rank, forecast_category: r.fields.forecast_category }),
    read: 'One point per gauge in bbox (default the Great Lakes basin). flood_rank 0 none, 1 action, 2 minor, 3 moderate, 4 major.' },
  epa_facilities: { label: 'Major EPA-regulated facilities', source: 'epa-echo', metric: 'facility_compliance', unit: 'quarters with non-compliance (of 12)', value: valueOf, events: true,
    extra: (r) => ({ compliance_status: r.fields.compliance_status, significant_noncomplier: r.fields.significant_noncomplier, naics: r.fields.naics, last_inspection: r.fields.last_inspection }),
    read: 'Major air, water and hazardous-waste permit holders in one state (state=XX, default OH). What EPA has recorded, not a finding about the facility today.' },
  recalls: { label: 'FDA recalls (food, drugs, devices)', source: 'openfda-recalls', metric: 'recall', unit: 'FDA class', value: valueOf, events: true,
    extra: (r) => ({ kind: r.fields.kind, classification: r.fields.classification, firm: r.fields.recalling_firm }), read: 'At the recalling firm’s ZIP (its centre, not the building). Class I is the most serious.' },
  contract_awards: { label: 'New federal contract awards', source: 'usaspending', metric: 'contract_award', unit: 'USD', value: valueOf, events: true,
    extra: (r) => ({ recipient: r.fields.recipient, agency: r.fields.agency }), read: 'The 100 largest new contracts of the last 30 days, at the place-of-performance ZIP.' },
  wildlife: { label: 'Wildlife and plant observations (GBIF)', source: 'gbif', metric: 'observation', unit: 'individuals', value: valueOf, events: true,
    extra: (r) => ({ species: r.fields.species, class: r.fields.class, kingdom: r.fields.kingdom }), read: 'The last two weeks, open-licensed records identified to species, inside bbox (default the whole world); group= picks birds, mammals, plants and so on.' },
  natural_events: { label: 'Natural events worldwide (NASA EONET)', source: 'nasa-eonet', metric: 'natural_event', unit: 'varies', value: valueOf, events: true,
    extra: (r) => ({ category: r.fields.category, category_title: r.fields.category_title }), read: 'Open storms, wildfires, volcanoes, floods, ice and dust events; the latest position of each.' },
  world_bank: { label: 'World Bank indicators by country', source: 'world-bank', metric: null, unit: 'varies', value: valueOf, events: true,
    extra: (r) => ({ indicator: r.fields.label, year: r.fields.year, region: r.fields.region }), read: 'Latest annual value per economy, at its capital; indicator= picks gdp_growth, inflation, manufacturing, exports, fdi or unemployment.' },
  earthquakes_emsc: { label: 'Earthquakes (EMSC, Europe-weighted)', source: 'emsc', metric: 'earthquake', unit: 'magnitude', value: valueOf, events: true,
    extra: (r) => ({ depth_km: r.fields.depth_km, region: r.fields.region, agency: r.fields.agency }),
    read: 'EMSC-CSEM events at their epicentre, densest over Europe and the Mediterranean; window= hour|day|week, min= all|2.5|4.5. Overlaps the USGS earthquakes layer elsewhere; kept separate so each point has one source.' },
  tropical_cyclones: { label: 'Tropical cyclones worldwide (IBTrACS)', source: 'noaa-ibtracs', metric: 'tropical_cyclone', unit: 'kt', value: valueOf, events: true,
    extra: (r) => ({ basin: r.fields.basin, category: r.fields.category, pressure_hpa: r.fields.pressure_hpa }),
    read: 'The latest best-track fix of every storm in the IBTrACS ACTIVE file, any basin, fixes within 7 days of the newest. Provisional tracks; NCEI refreshes the file every few days, so a fix can be a day or more old.' },
  power_plants: { label: 'Power plants (Global Energy Monitor)', source: 'gem-trackers', metric: 'power_plant', unit: 'MW', value: valueOf, events: true,
    extra: (r) => ({ fuel: r.fields.fuel, fuels: r.fields.fuels, status: r.fields.status, operating_mw: r.fields.operating_mw, construction_mw: r.fields.construction_mw,
      country: r.fields.country, first_unit_year: r.fields.first_unit_year }),
    read: 'GEM Global Integrated Power Tracker, plants of 50 MW or more operating or under construction; value is the two together. Default: 1000 MW or more worldwide; country=DEU gives every plant there of 50 MW or more; fuel= (coal, oil/gas, nuclear, hydropower, wind, utility-scale solar, geothermal, bioenergy), status= (operating, construction) and min_mw= narrow it.' },
  eu_industrial_production: { label: 'Industrial production by country (Eurostat)', source: 'eurostat', metric: null, unit: 'varies', value: valueOf, events: true,
    extra: (r) => ({ indicator: r.fields.label, month: r.fields.month, status: r.fields.status }),
    read: 'Latest month per country (EU, EFTA and candidates), at its capital. indicator=industrial_production is an index (2021 = 100); industrial_production_yoy is % on the same month a year earlier.' },
  fema_declarations: { label: 'FEMA disaster declarations (last 90 days)', source: 'openfema', metric: 'disaster_declaration', unit: 'declaration type', value: valueOf, events: true,
    extra: (r) => ({ declaration: r.fields.declaration, incident_type: r.fields.incident_type, declaration_type: r.fields.declaration_type, placed_at: r.fields.placed_at }),
    read: 'One point per declared county (its Census internal point), or a state point for statewide and tribal declarations. Value 3 major disaster, 2 emergency, 1 fire management. Uses the OpenFEMA API; not endorsed by FEMA.' },
  earthquakes: { label: 'Earthquakes', source: 'usgs-earthquakes', metric: 'earthquake', unit: 'magnitude', value: valueOf, events: true,
    extra: (r) => ({ depth_km: r.fields.depth_km, alert: r.fields.alert, tsunami: r.fields.tsunami }), read: 'One point per event at its epicentre; window and min select the USGS feed.' },
  // US freight and industrial emissions (src/fetchers/us-freight-emissions.js)
  lock_traffic: { label: 'Grain barge tonnage through inland-waterway locks', source: 'usda-ams-barge', metric: 'lock_grain_tonnage', unit: 'tons/week', value: valueOf, events: true,
    extra: (r) => ({ week_ending: r.fields.week_ending, corn: r.fields.corn, soybeans: r.fields.soybeans, wheat: r.fields.wheat, prior_4wk_avg_tons: r.fields.prior_4wk_avg_tons, river: r.fields.river }),
    read: 'Downbound grain only (not all commodities), latest week, at the seven locks USDA AMS reports from the USACE Lock Performance Monitoring System. No delay or queue data: the live USACE lock pages are not a keyless feed.' },
  border_crossings: { label: 'Border crossings by port of entry (BTS)', source: 'bts-border-crossings', metric: 'border_crossings', unit: 'trucks/month', value: valueOf, events: true,
    extra: (r) => ({ month: r.fields.month, border: r.fields.border, trucks: r.fields.trucks ?? null, trains: r.fields.trains ?? null, personal_vehicles: r.fields.personal_vehicles ?? null }),
    read: 'Inbound trucks in the latest month BTS has published, per US-Canada and US-Mexico port; border=canada|mexico narrows it. Container counts are no longer in the dataset.' },
  toxic_releases: { label: 'Toxic releases by facility (EPA TRI)', source: 'epa-tri', metric: 'toxic_release', unit: 'lb on site/year', value: valueOf, events: true,
    extra: (r) => ({ reporting_year: r.fields.reporting_year, industry_sector: r.fields.industry_sector, carcinogen_reported: r.fields.carcinogen_reported, dioxin_grams: r.fields.dioxin_grams }),
    read: 'Total on-site releases of TRI chemicals in the latest published reporting year, one state (state=XX, default OH). Self-reported by facilities; a release is not a violation. Dioxins (grams) are listed apart, not summed with pounds.' },
  power_emissions: { label: 'Power-plant emissions (EPA Clean Air Markets)', source: 'epa-campd', metric: 'power_emissions', unit: 'short tons CO2/month', value: valueOf, events: true,
    extra: (r) => ({ month: r.fields.month, so2_tons: r.fields.so2_tons, nox_tons: r.fields.nox_tons, gross_load_mwh: r.fields.gross_load_mwh, primary_fuels: r.fields.primary_fuels }),
    read: 'CO2, SO2 and NOx from the CAMPD daily bulk file, summed per facility over the latest month in it, one state (state=XX, default OH). EPA publishes the current year quarterly, so the latest month can be several months back.' },
  river_discharge: { label: 'River discharge, large rivers worldwide (GloFAS)', source: 'open-meteo-flood', metric: 'river_discharge', unit: 'm³/s', value: valueOf, events: true,
    extra: (r) => ({ river: r.fields.river, change_7d_pct: r.fields.change_7d_pct, ratio_to_ensemble_median: r.fields.ratio_to_ensemble_median, peak_30d_ensemble_max_m3s: r.fields.peak_30d_ensemble_max_m3s, peak_30d_date: r.fields.peak_30d_date }),
    read: 'Modelled daily discharge today (UTC) at about a hundred large-river locations, from GloFAS v4. change_7d_pct compares with a week ago; ratio_to_ensemble_median is against the median of the GloFAS ensemble for the day, not a long-term normal; peak_30d is the highest ensemble member over the next 30 days.' },
  air_quality: { label: 'Air quality, large cities worldwide (CAMS)', source: 'open-meteo-air', metric: 'air_quality', unit: 'US AQI', value: valueOf, events: true,
    extra: (r) => ({ us_aqi_category: r.fields.us_aqi_category, european_aqi: r.fields.european_aqi, pm2_5_ugm3: r.fields.pm2_5_ugm3, pm10_ugm3: r.fields.pm10_ugm3 }),
    read: 'Current modelled air quality at 150 large cities, from CAMS forecasts (about 11 km over Europe, 45 km elsewhere): a model, not a monitor at street level. US AQI 0-50 good, 51-100 moderate, 101-150 unhealthy for sensitive groups, 151-200 unhealthy, 201-300 very unhealthy, over 300 hazardous.' },
  volcanoes_world: { label: 'Volcanoes worldwide, recent eruptions (Smithsonian GVP)', source: 'smithsonian-gvp', metric: 'volcano_last_eruption', unit: 'year of last eruption', value: valueOf, events: true,
    extra: (r) => ({ continuing_eruption: r.fields.continuing_eruption, eruption_start: r.fields.eruption_start, country: r.fields.country, volcano_type: r.fields.volcano_type }),
    read: 'Holocene volcanoes whose last known eruption is in or after erupted_since (default 1900), from the Volcanoes of the World database; continuing=true keeps those GVP lists as erupting now. The US layer volcanoes carries USGS alert levels; this one has no alert levels.' },
  // US waterway, snow, drought, storm and wildfire layers (src/fetchers/us-water-hazards.js)
  lock_delays: { label: 'Lock queues and closures, Louisiana (USACE New Orleans District)', source: 'usace-mvn-locks', metric: 'lock_queue', unit: 'hours queue', value: valueOf, events: true,
    extra: (r) => ({ status: r.fields.status, status_rank: r.fields.status_rank, locking_count_primary: r.fields.locking_count_primary, locking_count_secondary: r.fields.locking_count_secondary, gage_primary_ft: r.fields.gage_primary_ft, gage_secondary_ft: r.fields.gage_secondary_ft }),
    read: 'Queue time in hours and open/restricted/closed status at the sixteen locks and floodgates of the USACE New Orleans District (Gulf Intracoastal Waterway, Atchafalaya, Mississippi), as entered by lock staff, usually daily. Only this district publishes a keyless feed; no other inland lock has queue or delay data here. status_rank 0 open, 1 restricted, 2 intermittent closure, 3 closed. US Government data, provided without warranty.' },
  snowpack: { label: 'Snowpack, snow water equivalent (NRCS SNOTEL)', source: 'nrcs-snotel', metric: 'snow_water_equivalent', unit: 'in SWE', value: valueOf, events: true,
    extra: (r) => ({ pct_of_median: r.fields.pct_of_median, median_in: r.fields.median_in, elevation_ft: r.fields.elevation_ft, median_peak_in: r.fields.median_peak_in }),
    read: 'Latest daily snow water equivalent at every active SNOTEL station (western US and Alaska), with its percent of the 1991-2020 median for the day; pct_of_median is null when the median is no snow. Provisional data, subject to revision.' },
  drought: { label: 'Drought by county (US Drought Monitor)', source: 'us-drought-monitor', metric: 'drought_category', unit: 'worst category (-1 none, 0 D0 … 4 D4)', value: valueOf, events: true,
    extra: (r) => ({ category: r.fields.category, pct_in_drought: r.fields.pct_in_drought, map_date: r.fields.map_date, previous_category: r.fields.previous_category, change: r.fields.change }),
    read: 'The current weekly map, one point per county at its Census internal point: the worst category touching the county and the percent of it in drought (D1+). Default only counties at D0 or worse; min=none|D0|D1|D2|D3|D4 and state=XX narrow it. change is +1 worse, -1 better than the week before. The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.' },
  storm_reports: { label: 'Storm reports today and yesterday (NOAA SPC)', source: 'noaa-spc-reports', metric: 'storm_report', unit: 'varies by kind', value: valueOf, events: true,
    extra: (r) => ({ kind: r.fields.kind, kind_rank: r.fields.kind_rank, convective_day: r.fields.convective_day, nws_office: r.fields.nws_office }),
    read: 'Preliminary filtered tornado, hail and damaging-wind reports for the current and previous SPC convective day (12 UTC to 12 UTC). value is the EF rating for a tornado (null if unknown), hail diameter in inches, or gust in mph (null if estimated from damage). kind= narrows it. Report comments are not served.' },
  wildfire_incidents: { label: 'Wildfires burning now (NIFC WFIGS)', source: 'nifc-wfigs', metric: 'wildfire_incident', unit: 'acres', value: valueOf, events: true,
    extra: (r) => ({ percent_contained: r.fields.percent_contained, discovered: r.fields.discovered, cause: r.fields.cause, gacc: r.fields.gacc, personnel: r.fields.personnel }),
    read: 'Every wildfire incident in IRWIN not yet declared contained, controlled or out, at its point of origin; small fires drop off after a few days without an update. kind=prescribed|all adds prescribed fires.' },
  // Live air traffic and what it reveals (src/fetchers/flights.js)
  aircraft: { label: 'Aircraft now (adsb.lol)', source: 'adsb-lol', metric: 'aircraft', unit: 'ft', value: valueOf, events: true, q: { mode: 'area' },
    extra: (r) => ({ callsign: r.fields.callsign, registration: r.fields.registration, type: r.fields.type, military: r.fields.military, ground_speed_kt: r.fields.ground_speed_kt, track_deg: r.fields.track_deg, squawk: r.fields.squawk }),
    read: 'Every aircraft heard by the adsb.lol receiver network within radius= nautical miles (default 100, max 250) of lat=/lng=. Value is barometric altitude, 0 on the ground. Coverage is wherever volunteers run receivers. Aircraft enrolled in the FAA LADD or PIA privacy programmes are never served.' },
  military_aircraft: { label: 'Military aircraft worldwide (adsb.lol)', source: 'adsb-lol', metric: 'aircraft', unit: 'ft', value: valueOf, events: true, q: { mode: 'military' },
    extra: (r) => ({ callsign: r.fields.callsign, registration: r.fields.registration, type: r.fields.type, ground_speed_kt: r.fields.ground_speed_kt, track_deg: r.fields.track_deg, squawk: r.fields.squawk }),
    read: 'Every aircraft the readsb database flags as military that a receiver hears right now, worldwide. Only aircraft transmitting ADS-B or seen by MLAT appear; most military flights do not broadcast, so absence means nothing.' },
  gps_interference: { label: 'GPS interference, inferred from aircraft (adsb.lol)', source: 'adsb-lol', metric: 'gps_interference', unit: '% of aircraft degraded', value: valueOf, events: true, q: { mode: 'gps' },
    extra: (r) => ({ level: r.fields.level, aircraft: r.fields.aircraft, degraded: r.fields.degraded }),
    read: 'Derived, not measured. Per 1° cell, the share of airborne aircraft (ADS-B v1+) reporting position accuracy NACp below 8, the GPSJam method; cells with fewer than 5 such aircraft are left out. Under 2% low, 2-10% medium, over 10% high; a cell with only one degraded aircraft stays low. Default looks at five regions (Baltic, Eastern Mediterranean, Persian Gulf, Red Sea, and the US Great Lakes as a quiet control) within radius= nm (default 250); lat=/lng= looks anywhere else. Avionics faults also lower NACp, so one cell on its own is a lead, not a finding.' },
  weather_alerts: { label: 'Weather watches and warnings (NWS)', source: 'nws-alerts', metric: 'weather_alert', unit: 'severity', value: valueOf, events: true,
    extra: (r) => ({ event: r.fields.event, severity: r.fields.severity, urgency: r.fields.urgency, onset: r.fields.onset, ends: r.fields.ends, expires: r.fields.expires }),
    read: 'Active NWS alerts, one point per alert per county (Census internal point). Value is NWS severity: 4 extreme, 3 severe, 2 moderate, 1 minor. state=XX, kind=warning|watch|advisory and event= (e.g. Red Flag Warning) narrow it; marine=true adds marine alerts at their polygon centre. Not a substitute for the official warning: follow NWS.' },
  reservoirs_west: { label: 'Reservoir storage, western US (Bureau of Reclamation)', source: 'usbr-rise', metric: 'reservoir_storage', unit: 'acre-feet', value: valueOf, events: true,
    extra: (r) => ({ change_7d_af: r.fields.change_7d_af, region: r.fields.region, status: r.fields.status }),
    read: 'Latest daily storage at about 215 Reclamation reservoirs (Upper and Lower Colorado, Missouri, Columbia-Pacific Northwest, California-Great Basin, Arkansas-Rio Grande), with the change over the previous week; region= narrows it. Provisional values. Storage only: RISE gives no capacity, so no percent full.' },
  ships_baltic: { label: 'Ships, Finnish waters and northern Baltic (Digitraffic AIS)', source: 'digitraffic-ais', metric: 'ship', unit: 'knots', value: valueOf, events: true,
    extra: (r) => ({ kind: r.fields.kind, destination: r.fields.destination, nav_status: r.fields.nav_status, course_deg: r.fields.course_deg, imo: r.fields.imo }),
    read: 'Live AIS positions from Finland\'s coastal receivers: the Gulf of Finland, Archipelago Sea, Gulf of Bothnia and nearby Baltic, not the open ocean. Value is speed over ground. type=cargo|tanker|passenger|fishing|tug|other narrows it. Pleasure and sailing craft are not served. The only open (CC BY) AIS feed found; global AIS needs a key.' },
  // Two sources on one event (src/fetchers/corroborate.js)
  quake_corroboration: { label: 'Earthquakes: do USGS and EMSC agree?', source: 'corroboration', metric: 'earthquake_corroboration', unit: 'agencies reporting', value: valueOf, events: true, q: { mode: 'earthquakes' },
    extra: (r) => ({ corroborated: r.fields.corroborated, relayed: r.fields.relayed, emsc_agency: r.fields.emsc_agency, mag_usgs: r.fields.mag_usgs, mag_emsc: r.fields.mag_emsc, mag_gap: r.fields.mag_gap, distance_km: r.fields.distance_km }),
    read: 'Derived. Every earthquake in the USGS or EMSC-CSEM catalogue for window= (default day) at min= (default 2.5), matched when origins are within 100 km and 60 s. Value 2 = both agencies report it independently; 1 = one only (often a small event outside the other network\'s dense coverage), or EMSC relaying a solution from a network USGS also carries (relayed=true). mag_gap is USGS minus EMSC.' },
  fire_corroboration: { label: 'Wildfires: does the satellite see them?', source: 'corroboration', metric: 'fire_corroboration', unit: 'VIIRS detections nearby', value: valueOf, events: true, q: { mode: 'fires' },
    extra: (r) => ({ corroborated: r.fields.corroborated, acres: r.fields.acres, frp_mw: r.fields.frp_mw, percent_contained: r.fields.percent_contained }),
    read: 'Derived. Each US wildfire incident not yet out (NIFC WFIGS) with the NASA FIRMS VIIRS detections of the last 24 hours within 5 km of its point of origin. Many detections: burning now. None: small, smouldering, under cloud, or moved off its origin; not proof it is out.' },
  // Satellite heat (src/fetchers/firms.js)
  fires: { label: 'Fires and heat, last 24 hours (NASA FIRMS VIIRS)', source: 'nasa-firms', metric: 'fire_detection', unit: 'MW radiative power', value: valueOf, events: true, q: { mode: 'fires' },
    extra: (r) => ({ confidence: r.fields.confidence, daynight: r.fields.daynight }),
    read: 'Every VIIRS 375 m detection (NOAA-20) of the last 24 hours at nominal or high confidence, inside bbox (default the whole world, the 5,000 strongest). A detection is heat, not necessarily a wildfire: gas flares, steel works and volcanoes show too; the persistent_heat layer separates those.' },
  persistent_heat: { label: 'Heat that stays put: industry, flares, volcanoes (from NASA FIRMS)', source: 'nasa-firms', metric: 'persistent_heat', unit: 'UTC dates with heat', value: valueOf, events: true, q: { mode: 'persistent' },
    extra: (r) => ({ of_days: r.fields.of_days, detections: r.fields.detections, mean_frp_mw: r.fields.mean_frp_mw, near_steel_plant: r.fields.near_steel_plant?.name ?? null, owner: r.fields.near_steel_plant?.owner ?? null, near_plant: r.fields.near_plant?.name ?? null }),
    read: 'Derived. ~1 km cells where VIIRS (Suomi NPP) saw heat on 3 or more of the last seven days. Wildfires move; heat that stays is usually a steel works, cement kiln, refinery, gas flare or volcano, but a long fire can qualify. The nearest steel plant (GEM Global Iron and Steel Tracker) and thermal power plant (GEM Global Integrated Power Tracker) within 3 km are named.' },
  steel_plant_heat: { label: 'Steel plants: is the furnace hot? (NASA FIRMS × GEM)', source: 'nasa-firms', metric: 'steel_plant_heat', unit: 'UTC dates with heat', value: valueOf, events: true, q: { mode: 'steel' },
    extra: (r) => ({ of_days: r.fields.of_days, detections: r.fields.detections, owner: r.fields.owner, parent: r.fields.parent, status: r.fields.status, prod_type: r.fields.prod_type, capacity_kt: r.fields.capacity_kt }),
    read: 'Derived. Every blast-furnace or DRI steel plant in GEM\'s Global Iron and Steel Tracker (operating, pre-retirement, mothballed or building), with how many of the last seven or eight UTC dates VIIRS saw heat within 3 km, and the owner and parent company. Heat at a plant listed mothballed is worth a look; no heat is weaker evidence (cloud hides it, and some units run cooler). Electric-arc mills are not listed: they rarely show.' },
};
