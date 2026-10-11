// USACE New Orleans lock status, NRCS SNOTEL, US Drought Monitor, NOAA SPC storm reports and NIFC WFIGS
// against payloads recorded from the real upstreams on 2026-10-10 (tests/fixtures, trimmed). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usaceMvnLocks, nrcsSnotel, usDroughtMonitor, spcStormReports, nifcWfigs, parseSpcReports, convectiveDay } from '../src/fetchers/us-water-hazards.js';
import { validateReading } from '../src/contract.js';
import { createService, LAYERS } from '../src/service.js';
import { I3X_LAYERS } from '../src/i3x.js';
import { source } from '../src/catalog.js';
import { NOW, res, stubFetch, ctx } from './helpers.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const valid = (rs) => rs.forEach((r) => assert.deepEqual(validateReading(r), [], JSON.stringify(r)));
const NEW_LAYERS = { lock_delays: 'usace-mvn-locks', snowpack: 'nrcs-snotel', drought: 'us-drought-monitor', storm_reports: 'noaa-spc-reports', wildfire_incidents: 'nifc-wfigs' };
const LICENCE = { 'us-drought-monitor': 'open' };

const routes = () => [
  [/Lock_Status\/FeatureServer\/1\/query/, () => res(200, fx('usace-mvn-lock-status.json'))],
  [/awdbRestApi\/services\/v1\/stations\?/, () => res(200, fx('snotel-stations.json'))],
  [/awdbRestApi\/services\/v1\/data\?/, () => res(200, fx('snotel-data.json'))],
  [/GetDroughtSeverityStatisticsByAreaPercent\?aoi=AL&/, () => res(200, fx('usdm-county-al.json'))],
  [/GetDroughtSeverityStatisticsByAreaPercent\?aoi=OH&/, () => res(200, fx('usdm-county-oh.json'))],
  [/GetDroughtSeverityStatisticsByAreaPercent\?aoi=/, () => res(200, '[]')],
  [/reports\/261010_rpts_filtered\.csv/, () => res(200, fx('spc-261010-filtered.csv'))],
  [/reports\/261009_rpts_filtered\.csv/, () => res(200, fx('spc-261009-filtered.csv'))],
  [/WFIGS_Incident_Locations_Current\/FeatureServer\/0\/query/, () => res(200, fx('wfigs-current.json'))],
];

test('new US layers: catalogued keyless with a terms URL, licence as read, an i3X folder', () => {
  for (const [id, src] of Object.entries(NEW_LAYERS)) {
    assert.equal(LAYERS[id].source, src, id);
    const s = source(src);
    assert.equal(s.license, LICENCE[src] ?? 'public_domain', src);
    assert.match(s.terms, /^https:\/\//, `${src} terms`);
    assert.equal(s.auth, null, `${src} is keyless`);
    assert.equal(s.fetcher, src);
    assert.ok(s.attribution, `${src} attribution`);
    assert.ok(I3X_LAYERS[id], `${id} on i3X`);
  }
  assert.match(source('us-drought-monitor').attribution, /Map courtesy of NDMC\.$/);
});

test('lock_delays: queue hours and status per lock; staff names, phones, emails and remarks are never requested', async () => {
  const f = stubFetch(routes());
  const { readings } = await usaceMvnLocks.fetch(ctx(f));
  const out = new URL(f.calls[0].url).searchParams.get('outFields').split(',');
  for (const k of ['PERSON_NAME', 'PERSON_TITLE', 'WORK_PHONE', 'EMAIL_ADDRESS', 'LOCK_REMARKS', 'LOCK_NOTICES', 'CLOSURE_SCHEDULE']) assert.ok(!out.includes(k), k);
  assert.ok(!out.includes('*'));
  valid(readings);
  assert.equal(readings.length, 16);
  const raw = JSON.parse(fx('usace-mvn-lock-status.json')).features;
  const algiers = readings.find((r) => r.place.name === 'Algiers Lock');
  const a = raw.find((x) => x.attributes.LOCK_NAME === 'Algiers Lock');
  assert.equal(algiers.value, a.attributes.QUEUE_TIME_HOURS);
  assert.equal(algiers.at, new Date(a.attributes.STATUS_DATE).toISOString());
  assert.deepEqual([algiers.place.lat, algiers.place.lng], [a.geometry.y, a.geometry.x]);
  assert.equal(readings.find((r) => r.place.name === 'Berwick Lock').fields.status_rank, 3);
  assert.equal(readings.find((r) => r.place.name === 'Calcasieu Lock').fields.status, 'Intermittent Closure');
  // even if the upstream sent them, nothing but the named fields reaches a reading
  const leaky = { features: [{ attributes: { ...a.attributes, PERSON_NAME: 'Jane Q Example', EMAIL_ADDRESS: 'jane@example.mil', LOCK_REMARKS: 'Lockmaster Jane Q Example' }, geometry: a.geometry }] };
  const { readings: [r] } = await usaceMvnLocks.fetch(ctx(stubFetch([[/Lock_Status/, () => res(200, leaky)]])));
  assert.ok(!/Jane|example\.mil/.test(JSON.stringify(r)));
});

test('lock_delays: an ArcGIS error body (HTTP 200) is an upstream failure, not an empty ok', async () => {
  await assert.rejects(usaceMvnLocks.fetch(ctx(stubFetch([[/Lock_Status/, () => res(200, { error: { code: 400, message: 'Invalid URL' } })]]))), /ArcGIS error/);
});

test('snowpack: latest daily SWE per station, percent of median only when the median is above zero', async () => {
  const f = stubFetch(routes());
  const { readings } = await nrcsSnotel.fetch(ctx(f));
  const dataUrl = f.calls.find((c) => /\/data\?/.test(c.url)).url;
  assert.match(dataUrl, /elements=WTEQ&duration=DAILY&beginDate=2026-10-07&endDate=2026-10-10&centralTendencyType=MEDIAN/);
  valid(readings);
  const data = JSON.parse(fx('snotel-data.json'));
  assert.equal(readings.length, data.length);
  for (const r of readings) {
    const vs = data.find((d) => d.stationTriplet === r.fields.station_triplet).data[0].values;
    const last = vs[vs.length - 1];
    assert.equal(r.at, last.date);
    assert.equal(r.value, last.value);
    assert.equal(r.fields.pct_of_median, last.median > 0 ? Math.round((last.value / last.median) * 100) : null);
    assert.ok(r.place && r.place.state && Number.isFinite(r.place.lat), r.id);
  }
  assert.ok(readings.some((r) => r.value > 0), 'fixture carries snow somewhere');
});

test('drought: worst category per county from the latest map, previous week for change, at county points; min and state', async () => {
  const f = stubFetch(routes());
  const { readings } = await usDroughtMonitor.fetch(ctx(f));
  assert.equal(f.calls.length, 52, 'one request per state, DC and PR');
  assert.match(decodeURIComponent(f.calls[0].url), /startdate=9\/27\/2026&enddate=10\/10\/2026&statisticsType=2/);
  valid(readings);
  const al = [...JSON.parse(fx('usdm-county-al.json')), ...JSON.parse(fx('usdm-county-oh.json'))];
  const latest = (fips) => al.filter((r) => r.fips === fips).sort((a, b) => b.mapDate.localeCompare(a.mapDate))[0];
  const want = al.map((r) => r.fips).filter((v, i, xs) => xs.indexOf(v) === i).filter((fips) => ['d0', 'd1', 'd2', 'd3', 'd4'].some((k) => latest(fips)[k] > 0));
  assert.ok(want.length < 8, 'the fixture has counties with none');
  assert.deepEqual(readings.map((r) => r.fields.fips).sort(), want.sort(), 'default min D0 drops counties with none');
  const autauga = readings.find((r) => r.fields.fips === '01001');
  const L = latest('01001');
  const cat = [4, 3, 2, 1, 0].find((i) => L[`d${i}`] > 0);
  assert.equal(autauga.value, cat);
  assert.equal(autauga.at, L.mapDate.slice(0, 10));
  assert.equal(autauga.fields.pct_in_drought, Math.round((L.d1 + L.d2 + L.d3 + L.d4) * 100) / 100);
  assert.equal(autauga.place.name, 'Autauga County, AL');
  assert.ok(autauga.place.lat > 32 && autauga.place.lng < -86);
  assert.equal(autauga.source.license, 'open');
  const all = await usDroughtMonitor.fetch(ctx(stubFetch(routes()), { params: { min: 'none' } }));
  assert.equal(all.readings.length, 8);
  assert.equal(all.readings.filter((r) => r.value === -1).length, 8 - want.length);
  const g = stubFetch(routes());
  await usDroughtMonitor.fetch(ctx(g, { params: { state: 'al' } }));
  assert.equal(g.calls.length, 1);
  await assert.rejects(usDroughtMonitor.fetch(ctx(stubFetch(routes()), { params: { state: 'ZZ' } })), (e) => e.status === 400);
});

test('storm_reports: today and yesterday by convective day, three sections, UTC times past midnight roll over, comments dropped', async () => {
  assert.equal(convectiveDay(new Date('2026-10-11T01:43:00Z')), '2026-10-10');
  assert.equal(convectiveDay(new Date('2026-10-11T12:00:00Z')), '2026-10-11');
  const f = stubFetch(routes());
  const { readings } = await spcStormReports.fetch(ctx(f));
  assert.match(f.calls[0].url, /261010_rpts_filtered\.csv$/);
  assert.match(f.calls[1].url, /261009_rpts_filtered\.csv$/);
  valid(readings);
  const kinds = (k) => readings.filter((r) => r.fields.kind === k).length;
  const rows = (t) => fx(t).split('\n').filter((l) => /^\d{3,4},/.test(l)).length;
  assert.equal(readings.length, rows('spc-261010-filtered.csv') + rows('spc-261009-filtered.csv'));
  assert.deepEqual([kinds('tornado'), kinds('wind'), kinds('hail')], [9, 11, 0]);
  const gust = readings.find((r) => r.fields.location === '4 NNE Murrieta');
  assert.equal(gust.value, 66);
  assert.equal(gust.at, '2026-10-10T20:20:00Z');
  assert.equal(gust.fields.nws_office, 'SGX');
  assert.equal(readings.find((r) => r.fields.location === '5 WNW Oliver').value, null, 'UNK rating is null, not zero');
  assert.ok(!/Fire Chief|911 call|Burtons Ferry/.test(JSON.stringify(readings)), 'comment text is not served');
  const csv = 'Time,F_Scale,Location,County,State,Lat,Lon,Comments\nTime,Speed,Location,County,State,Lat,Lon,Comments\nTime,Size,Location,County,State,Lat,Lon,Comments\n'
    + '0130,175,2 N Town,Some,KS,38.1,-98.2,"Jane Doe reported hail, 1.75 inch. (ICT)"\n';
  const [h] = parseSpcReports(csv, '2026-10-10');
  assert.deepEqual([h.kind, h.magnitude, h.at, h.office], ['hail', 1.75, '2026-10-11T01:30:00Z', 'ICT']);
  assert.ok(!('comments' in h) && !JSON.stringify(h).includes('Jane'));
  const g = stubFetch([[/261010/, () => res(404, 'nope')], [/261009/, () => res(200, fx('spc-261009-filtered.csv'))]]);
  const y = await spcStormReports.fetch(ctx(g, { params: { kind: 'wind' } }));
  assert.equal(y.readings.length, 1, 'yesterday: one wind report');
  assert.equal(y.readings[0].fields.convective_day, '2026-10-09');
  assert.equal(y.readings[0].at, '2026-10-09T21:42:00Z');
});

test('wildfire_incidents: wildfires only by default, largest first, acres and containment, no free text', async () => {
  const f = stubFetch(routes());
  const { readings } = await nifcWfigs.fetch(ctx(f));
  const q = new URL(f.calls[0].url).searchParams;
  assert.equal(q.get('where'), "IncidentTypeCategory='WF'");
  assert.equal(q.get('resultRecordCount'), '2000');
  assert.ok(!/ShortDescription|ApprovedBy/.test(q.get('outFields')));
  valid(readings);
  const raw = JSON.parse(fx('wfigs-current.json')).features;
  assert.equal(readings.length, raw.length);
  const top = readings[0], a = raw[0].attributes;
  assert.equal(top.value, a.IncidentSize);
  assert.equal(top.fields.percent_contained, a.PercentContained);
  assert.equal(top.fields.discovered, new Date(a.FireDiscoveryDateTime).toISOString());
  assert.equal(top.place.state, a.POOState.replace('US-', ''));
  assert.ok(readings.some((r) => r.fields.percent_contained === null && /containment not reported/.test(r.summary)));
  const g = stubFetch(routes());
  await nifcWfigs.fetch(ctx(g, { params: { kind: 'all' } }));
  assert.equal(new URL(g.calls[0].url).searchParams.get('where'), "IncidentTypeCategory IN ('WF','RX')");
});

test('new US layers through layer(): GeoJSON events with source, licence and attribution', async () => {
  const service = createService({ now: () => NOW, env: {}, fetch: stubFetch(routes()) });
  const counts = {};
  for (const id of Object.keys(NEW_LAYERS)) {
    const g = await service.layer(id, {}, { mode: 'serve' });
    assert.equal(g.type, 'FeatureCollection');
    assert.equal(g.source.id, NEW_LAYERS[id]);
    assert.equal(g.source.license, LICENCE[NEW_LAYERS[id]] ?? 'public_domain');
    assert.ok(g.source.attribution, id);
    assert.ok(g.features.every((ft) => Number.isFinite(ft.geometry.coordinates[0]) && ft.properties.url), id);
    counts[id] = g.features.length;
  }
  assert.deepEqual(counts, { lock_delays: 16, snowpack: 5, drought: 4, storm_reports: 20, wildfire_incidents: 4 });
});
