/**
 * US waterway, snow, drought, storm and wildfire layers. All keyless; each source's terms were read on
 * 2026-10-10 and are linked from its catalogue entry.
 *
 *   usace-mvn-locks    lock status and queue time at the US Army Corps of Engineers New Orleans District
 *                      locks, updated by lock staff (ArcGIS feature service "Lock Status", owned by USACE
 *                      MVD). Only status, queue, locking counts and gauges are requested: the service also
 *                      carries the names, phones and emails of lock staff, and free-text remarks that name
 *                      them, which are never fetched. The national Lock Performance Monitoring System pages
 *                      (corpslocks.usace.army.mil) do not resolve, so no other district has a keyless feed.
 *   nrcs-snotel        current snow water equivalent and its percent of the 1991-2020 daily median at every
 *                      active SNOTEL station, from the NRCS AWDB REST API (two requests).
 *   us-drought-monitor the current US Drought Monitor map as county statistics (percent of each county in
 *                      each category), from the USDM REST service, one request per state.
 *   noaa-spc-reports   NOAA Storm Prediction Center filtered storm reports (tornado, wind, hail) for the
 *                      current and previous convective day. The free-text comments are dropped: they can
 *                      name people and street addresses. Only the issuing office code is kept from them.
 *   nifc-wfigs         wildfire incidents not yet contained, controlled or out, from the NIFC WFIGS
 *                      "Current Wildland Fire Incident Locations" feature service.
 */

import { reading } from '../contract.js';
import { getJson, getText, localDate } from './http.js';
import { csvRows } from './us-freight-emissions.js';
import { US_STATES } from './epa-echo.js';
import { fipsPoint } from './fema.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** ArcGIS REST query; ArcGIS answers errors with 200 and an `error` body, which this throws. */
async function arcgisQuery(f, layerUrl, params, timeoutMs = 30000) {
  const qs = new URLSearchParams({ f: 'json', outSR: '4326', returnGeometry: 'true', ...params });
  const d = await getJson(f, `${layerUrl}/query?${qs}`, {}, timeoutMs);
  if (d.error) throw new Error(`ArcGIS error from ${new URL(layerUrl).host}: ${JSON.stringify(d.error).slice(0, 200)}`);
  return d.features || [];
}

/** Run fn over items, at most n at a time, results in input order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ---------------------------------------------------------------- lock delays (USACE New Orleans District)

export const MVN_LOCKS_URL = 'https://services8.arcgis.com/auEgdZ2hucgD0iTE/arcgis/rest/services/Lock_Status/FeatureServer/1';
// Deliberately excludes PERSON_NAME, PERSON_TITLE, WORK_PHONE, EMAIL_ADDRESS, ADDRESS_CITY_AND_STATE and the
// free-text LOCK_REMARKS, LOCK_NOTICES and CLOSURE_SCHEDULE, which name lock staff.
const MVN_FIELDS = ['LOCK_ID', 'LOCK_NAME', 'PRIMARY_CHANNEL_NAME', 'SECONDARY_CHANNEL_NAME', 'STATUS_DATE', 'LOCK_STATUS', 'OPEN_FLOW_FLAG',
  'PRIMARY_CHNL_LOCKING_COUNT', 'SECONDARY_CHNL_LOCKING_COUNT', 'PRIMARY_CHNL_GAGE_READING', 'SECONDARY_CHNL_GAGE_READING', 'QUEUE_TIME_HOURS'];
const LOCK_STATUS_RANK = { open: 0, restricted: 1, 'intermittent closure': 2, closed: 3 };

export const usaceMvnLocks = {
  source: 'usace-mvn-locks',
  metrics: ['lock_queue'],
  places: 'none needed: every lock and floodgate the New Orleans District reports, at its own position',
  async fetch({ fetch: f, now, src }) {
    const source = src('usace-mvn-locks');
    const feats = await arcgisQuery(f, MVN_LOCKS_URL, { where: '1=1', outFields: MVN_FIELDS.join(','), resultRecordCount: '200' });
    const out = [];
    for (const { attributes: a = {}, geometry: g } of feats) {
      const at = iso(a.STATUS_DATE);
      if (!at || !a.LOCK_NAME) continue;
      const status = String(a.LOCK_STATUS || '').trim() || null;
      const q = num(a.QUEUE_TIME_HOURS);
      const channels = [a.PRIMARY_CHANNEL_NAME, a.SECONDARY_CHANNEL_NAME].filter(Boolean);
      out.push(reading({
        source, id: `${a.LOCK_ID}:${at}`, at, metric: 'lock_queue',
        place: g ? { id: `usace-mvn-lock-${a.LOCK_ID}`, name: a.LOCK_NAME, lat: g.y, lng: g.x } : null,
        value: q, unit: 'hours queue',
        summary: `${a.LOCK_NAME}: ${status || 'status not reported'}, ${q == null ? 'queue not reported' : `${q} h queue`}`
          + `${a.PRIMARY_CHNL_LOCKING_COUNT != null || a.SECONDARY_CHNL_LOCKING_COUNT != null ? `, locking count ${a.PRIMARY_CHNL_LOCKING_COUNT ?? '-'} / ${a.SECONDARY_CHNL_LOCKING_COUNT ?? '-'} (${a.PRIMARY_CHANNEL_NAME || 'primary'} / ${a.SECONDARY_CHANNEL_NAME || 'secondary'} side)` : ''}`
          + ` (as of ${at.slice(0, 16).replace('T', ' ')} UTC)`,
        fields: { status, status_rank: status ? LOCK_STATUS_RANK[status.toLowerCase()] ?? null : null, open_flow: a.OPEN_FLOW_FLAG === 'Y',
          queue_hours: q, locking_count_primary: num(a.PRIMARY_CHNL_LOCKING_COUNT), locking_count_secondary: num(a.SECONDARY_CHNL_LOCKING_COUNT),
          primary_channel: a.PRIMARY_CHANNEL_NAME || null, secondary_channel: a.SECONDARY_CHANNEL_NAME || null,
          gage_primary_ft: num(a.PRIMARY_CHNL_GAGE_READING), gage_secondary_ft: num(a.SECONDARY_CHNL_GAGE_READING), channels, district: 'USACE New Orleans District (MVN)' },
        url: 'https://www.arcgis.com/home/item.html?id=d6c337ffafdf4dfe89c30e890fac48e5', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- snowpack (NRCS SNOTEL)

const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';

export const nrcsSnotel = {
  source: 'nrcs-snotel',
  metrics: ['snow_water_equivalent'],
  places: 'none needed: every active SNOTEL station, at its own position',
  async fetch({ fetch: f, now, src }) {
    const source = src('nrcs-snotel');
    const end = localDate(now, 'UTC');
    const begin = localDate(new Date(now.getTime() - 3 * 86400e3), 'UTC');
    const [stations, data] = await Promise.all([
      getJson(f, `${AWDB}/stations?stationTriplets=*:*:SNTL&activeOnly=true&returnForecastPointMetadata=false&returnReservoirMetadata=false&returnStationElements=false`, {}, 120000),
      getJson(f, `${AWDB}/data?stationTriplets=*:*:SNTL&elements=WTEQ&duration=DAILY&beginDate=${begin}&endDate=${end}&centralTendencyType=MEDIAN&periodRef=END`, {}, 150000),
    ]);
    const meta = new Map(stations.map((s) => [s.stationTriplet, s]));
    const out = [];
    for (const st of data) {
      const s = meta.get(st.stationTriplet);
      const series = (st.data || []).find((d) => d.stationElement?.elementCode === 'WTEQ');
      const last = (series?.values || []).filter((v) => num(v.value) != null).sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!s || !last) continue;
      const swe = num(last.value), med = num(last.median);
      const pct = med != null && med > 0 ? Math.round((swe / med) * 100) : null;
      const peak = series.timingCentralTendencies?.medianPeak;
      out.push(reading({
        source, id: `${st.stationTriplet}:${last.date}`, at: last.date.slice(0, 10), metric: 'snow_water_equivalent',
        place: { id: `snotel-${st.stationTriplet.replace(/:/g, '-')}`, name: `${s.name} SNOTEL`, lat: num(s.latitude), lng: num(s.longitude), state: s.stateCode },
        value: swe, unit: 'in snow water equivalent',
        summary: `${s.name} SNOTEL, ${s.stateCode} (${Math.round(s.elevation).toLocaleString('en-US')} ft): ${swe} in of snow water equivalent on ${last.date.slice(0, 10)}`
          + `${pct != null ? `, ${pct}% of the median for the day (${med} in)` : med === 0 ? ', median for the day is no snow' : ''}`,
        fields: { station_triplet: st.stationTriplet, station_id: s.stationId, elevation_ft: num(s.elevation), county: s.countyName || null, huc: s.huc || null,
          pct_of_median: pct, median_in: med, median_peak_in: num(peak?.value), median_peak_date: peak ? `${String(peak.month).padStart(2, '0')}-${String(peak.day).padStart(2, '0')}` : null },
        url: `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${s.stationId}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- drought (US Drought Monitor)

const USDM = 'https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent';
const CATS = ['d0', 'd1', 'd2', 'd3', 'd4'];
const CAT_LABEL = ['abnormally dry', 'moderate drought', 'severe drought', 'extreme drought', 'exceptional drought'];
const MIN = { none: -1, D0: 0, D1: 1, D2: 2, D3: 3, D4: 4 };
/** Worst category with any area in the county: 0 D0 … 4 D4, -1 none. */
const worst = (r) => { for (let i = 4; i >= 0; i--) if (num(r[CATS[i]]) > 0) return i; return -1; };
const mdy = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

export const usDroughtMonitor = {
  source: 'us-drought-monitor',
  metrics: ['drought_category'],
  places: 'none needed: every county (or one state with state=XX), at its Census internal point',
  params: { state: US_STATES, min: Object.keys(MIN) },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('us-drought-monitor');
    const st = String(params.state || '').toUpperCase();
    if (st && !US_STATES.includes(st)) { const e = new Error(`state must be one of ${US_STATES.join(', ')}`); e.status = 400; throw e; }
    const min = MIN[params.min] ?? MIN.D0;
    const range = `startdate=${mdy(new Date(now.getTime() - 13 * 86400e3))}&enddate=${mdy(now)}&statisticsType=2`;
    const states = st ? [st] : US_STATES;
    const rowsByState = await pool(states, 6, (s) => getJson(f, `${USDM}?aoi=${s}&${range}`, { headers: { Accept: 'application/json' } }, 30000));
    const out = [];
    for (const rows of rowsByState) {
      const byFips = new Map();
      for (const r of rows || []) (byFips.get(r.fips) || byFips.set(r.fips, []).get(r.fips)).push(r);
      for (const [fips, rs] of byFips) {
        rs.sort((a, b) => b.mapDate.localeCompare(a.mapDate));
        const r = rs[0], prev = rs[1];
        const cat = worst(r);
        if (cat < min) continue;
        const pt = fipsPoint(fips);
        const date = r.mapDate.slice(0, 10);
        const inDrought = round(CATS.slice(1).reduce((a, k) => a + (num(r[k]) ?? 0), 0), 2);
        out.push(reading({
          source, id: `${fips}:${date}`, at: date, metric: 'drought_category',
          place: pt ? { id: `fips-${fips}`, name: `${r.county}, ${r.state}`, lat: pt.lat, lng: pt.lng, state: r.state } : null,
          value: cat, unit: 'worst drought category in the county (-1 none, 0 D0 … 4 D4)',
          summary: `${r.county}, ${r.state}, US Drought Monitor map of ${date}: ${cat < 0 ? 'no drought or dryness' : `up to D${cat} (${CAT_LABEL[cat]})`}, ${inDrought}% of the county in drought (D1 or worse)`,
          fields: { fips, county: r.county, state: r.state, map_date: date, valid_end: String(r.validEnd || '').slice(0, 10) || null, category: cat < 0 ? 'none' : `D${cat}`,
            pct_in_drought: inDrought, pct_none: num(r.none), pct_d0: num(r.d0), pct_d1: num(r.d1), pct_d2: num(r.d2), pct_d3: num(r.d3), pct_d4: num(r.d4),
            previous_map_date: prev ? prev.mapDate.slice(0, 10) : null, previous_category: prev ? (worst(prev) < 0 ? 'none' : `D${worst(prev)}`) : null,
            change: prev ? Math.sign(cat - worst(prev)) : null },
          url: 'https://droughtmonitor.unl.edu/CurrentMap.aspx', fetchedAt: now.toISOString(),
        }));
      }
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- storm reports (NOAA SPC)

const SPC = 'https://www.spc.noaa.gov/climo/reports';
const KIND = { F_Scale: 'tornado', Speed: 'wind', Size: 'hail' };
const KIND_RANK = { tornado: 3, wind: 1, hail: 2 };

/** The SPC convective day (12 UTC to 12 UTC) containing `t`, as YYYY-MM-DD. */
export const convectiveDay = (t) => new Date(t.getTime() - 12 * 3600e3).toISOString().slice(0, 10);

/** One filtered-reports CSV (three sections, each with its own header) → reports, comments dropped. */
export function parseSpcReports(text, day) {
  const out = [];
  let kind = null;
  for (const row of csvRows(text)) {
    if (row[0] === 'Time') { kind = KIND[row[1]] || null; continue; }
    if (!kind || !/^\d{3,4}$/.test(row[0])) continue;
    const hhmm = row[0].padStart(4, '0');
    const lat = num(row[5]), lng = num(row[6]);
    const office = (String(row[7] || '').match(/\(([A-Z]{3})\)\s*$/) || [])[1] || null;
    // Times are UTC; the convective day runs 12:00 to 11:59 UTC, so a report before 12:00 is on the next calendar day.
    const date = hhmm < '1200' ? new Date(Date.parse(`${day}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10) : day;
    const mag = num(row[1]);
    out.push({ kind, day, at: `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`, magnitude: kind === 'hail' && mag != null ? mag / 100 : mag,
      location: row[2] || null, county: row[3] || null, state: row[4] || null, lat, lng, office });
  }
  return out;
}

export const spcStormReports = {
  source: 'noaa-spc-reports',
  metrics: ['storm_report'],
  places: 'none needed: each report at its own position',
  params: { kind: ['all', 'tornado', 'hail', 'wind'] },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('noaa-spc-reports');
    const today = convectiveDay(now);
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
    const out = [];
    for (const day of [today, yesterday]) {
      const file = `${day.slice(2).replace(/-/g, '')}_rpts_filtered.csv`;
      let text;
      try { text = await getText(f, `${SPC}/${file}`, {}, 30000); } catch (e) { if (e.status === 404) continue; throw e; }
      const seen = new Map();
      for (const r of parseSpcReports(text, day)) {
        if (params.kind && params.kind !== 'all' && r.kind !== params.kind) continue;
        const base = `${day}:${r.kind}:${r.at.slice(11, 16)}:${r.lat},${r.lng}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        const what = r.kind === 'tornado' ? `tornado${r.magnitude != null ? ` (EF${r.magnitude})` : ''}`
          : r.kind === 'hail' ? `hail${r.magnitude != null ? ` ${r.magnitude} in` : ''}` : `damaging wind${r.magnitude != null ? ` ${r.magnitude} mph` : ''}`;
        out.push(reading({
          source, id: n > 1 ? `${base}:${n}` : base, at: r.at, metric: 'storm_report',
          place: { id: `spc-${r.kind}-${r.at}-${r.lat}_${r.lng}`, name: `${r.location}, ${r.county} County, ${r.state}`, lat: r.lat, lng: r.lng, state: r.state },
          value: r.magnitude, unit: { tornado: 'EF scale', hail: 'in hail diameter', wind: 'mph gust' }[r.kind],
          summary: `Preliminary ${what} report, ${r.location}, ${r.county} County, ${r.state}, ${r.at.slice(0, 16).replace('T', ' ')} UTC${r.office ? ` (NWS ${r.office})` : ''}`,
          fields: { kind: r.kind, kind_rank: KIND_RANK[r.kind], magnitude: r.magnitude, convective_day: day, location: r.location, county: r.county, state: r.state, nws_office: r.office },
          url: `${SPC}/${day.slice(2).replace(/-/g, '')}_rpts.html`, fetchedAt: now.toISOString(),
        }));
      }
    }
    return { status: 'ok', readings: out };
  },
};

// ---------------------------------------------------------------- wildfire incidents (NIFC WFIGS)

export const WFIGS_URL = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0';
const WFIGS_FIELDS = ['UniqueFireIdentifier', 'IrwinID', 'IncidentName', 'IncidentTypeCategory', 'IncidentSize', 'PercentContained', 'FireDiscoveryDateTime',
  'ModifiedOnDateTime_dt', 'POOState', 'POOCounty', 'FireCauseGeneral', 'GACC', 'TotalIncidentPersonnel', 'IncidentComplexityLevel', 'POOLandownerKind'];
const WFIGS_KIND = { wildfire: "IncidentTypeCategory='WF'", prescribed: "IncidentTypeCategory='RX'", all: "IncidentTypeCategory IN ('WF','RX')" };

export const nifcWfigs = {
  source: 'nifc-wfigs',
  metrics: ['wildfire_incident'],
  places: 'none needed: each incident at its point of origin',
  params: { kind: Object.keys(WFIGS_KIND) },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('nifc-wfigs');
    const where = WFIGS_KIND[params.kind] || WFIGS_KIND.wildfire;
    const feats = await arcgisQuery(f, WFIGS_URL, { where, outFields: WFIGS_FIELDS.join(','), orderByFields: 'IncidentSize DESC', resultRecordCount: '2000' }, 60000);
    const out = [];
    for (const { attributes: a = {}, geometry: g } of feats) {
      const at = iso(a.ModifiedOnDateTime_dt) || iso(a.FireDiscoveryDateTime);
      if (!at || !a.UniqueFireIdentifier) continue;
      const st = String(a.POOState || '').replace(/^US-/, '') || null;
      const acres = num(a.IncidentSize), pct = num(a.PercentContained);
      const name = `${String(a.IncidentName || 'Unnamed').trim()} ${a.IncidentTypeCategory === 'RX' ? 'prescribed fire' : 'Fire'}`;
      out.push(reading({
        source, id: `${a.UniqueFireIdentifier}:${at}`, at, metric: 'wildfire_incident',
        place: g ? { id: `wfigs-${a.UniqueFireIdentifier}`, name: `${name}${st ? `, ${st}` : ''}`, lat: g.y, lng: g.x, ...(st ? { state: st } : {}) } : null,
        value: acres, unit: 'acres',
        summary: `${name}${a.POOCounty ? `, ${a.POOCounty} County` : ''}${st ? `, ${st}` : ''}: ${acres == null ? 'size not reported' : `${acres.toLocaleString('en-US')} acres`}`
          + `${pct != null ? `, ${pct}% contained` : ', containment not reported'}${a.FireDiscoveryDateTime ? `, discovered ${iso(a.FireDiscoveryDateTime).slice(0, 10)}` : ''}`,
        fields: { unique_fire_id: a.UniqueFireIdentifier, irwin_id: a.IrwinID || null, incident_name: a.IncidentName || null, type: a.IncidentTypeCategory, acres, percent_contained: pct,
          discovered: iso(a.FireDiscoveryDateTime), updated: iso(a.ModifiedOnDateTime_dt), state: st, county: a.POOCounty || null, cause: a.FireCauseGeneral || null,
          gacc: a.GACC || null, personnel: num(a.TotalIncidentPersonnel), complexity: a.IncidentComplexityLevel || null, landowner: a.POOLandownerKind || null },
        url: 'https://www.arcgis.com/home/item.html?id=4181a117dc9e43db8598533e29972015', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
