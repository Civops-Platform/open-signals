/**
 * Water: NOAA CO-OPS water levels, USGS river gauges, NOAA GLERL Great Lakes ice.
 * All US government work (public domain).
 * Ported from Civops-Platform/signals src/pipelines/waterfowl/sources.js.
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

const DATUM_NAMES = { LWD: 'low water datum', MLLW: 'mean lower low water' };
const coopsUrl = (station, datum) => `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${station}&product=water_level`
  + `&datum=${datum}&units=english&time_zone=gmt&format=json&range=72&application=open-signals`;

/** Daily mean/min/max of the last 72 hours at each CO-OPS station (place.refs.coops). */
export const coops = {
  source: 'noaa-coops',
  metrics: ['water_level'],
  places: 'places with refs.coops (a CO-OPS station id, e.g. 9063085)',
  async fetch({ fetch: f, now, places, src }) {
    const source = src('noaa-coops');
    const out = [];
    for (const pl of places.filter((p) => p.refs?.coops)) {
      const station = pl.refs.coops;
      // Great Lakes stations report against Low Water Datum; tidal stations have
      // no LWD and report against Mean Lower Low Water. Ask for LWD first.
      let datum = 'LWD';
      let data;
      try {
        data = await getJson(f, coopsUrl(station, datum));
      } catch (e) {
        if (!(e.status === 400 && /no LWD/i.test(e.body || ''))) throw e;
        datum = 'MLLW';
        data = await getJson(f, coopsUrl(station, datum));
      }
      if (data.error) throw new Error(`CO-OPS ${station}: ${data.error.message}`);
      const m = data.metadata || {};
      const place = {
        ...pl,
        name: pl.name || m.name || `CO-OPS ${station}`,
        lat: Number.isFinite(pl.lat) ? pl.lat : Number(m.lat),
        lng: Number.isFinite(pl.lng) ? pl.lng : Number(m.lon),
      };
      const byDay = new Map();
      for (const p of data.data || []) {
        const v = Number(p.v);
        if (p.v === '' || !Number.isFinite(v)) continue;
        const day = localDate(new Date(p.t.replace(' ', 'T') + 'Z'));
        (byDay.get(day) || byDay.set(day, []).get(day)).push(v);
      }
      for (const [day, vs] of byDay) {
        const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
        out.push(reading({
          source, id: `${station}:${day}`, at: day, metric: 'water_level', place,
          value: Math.round(mean * 1000) / 1000, unit: `ft above ${datum}`,
          summary: `${place.name} ${day}: mean ${mean.toFixed(2)} ft above ${DATUM_NAMES[datum]} (range ${Math.min(...vs).toFixed(2)}–${Math.max(...vs).toFixed(2)}, ${vs.length} readings, preliminary)`,
          fields: { station, mean_ft: mean, min_ft: Math.min(...vs), max_ft: Math.max(...vs), readings: vs.length, datum, quality: 'preliminary' },
          url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station}`, fetchedAt: now.toISOString(),
        }));
      }
    }
    return { status: 'ok', readings: out };
  },
};

export const USGS_PARAMETERS = {
  '00060': { name: 'discharge', unit: 'ft3/s' },
  '00065': { name: 'gage_height', unit: 'ft' },
};

/** Latest discharge and gage height at each USGS gauge (place.refs.usgs, e.g. USGS-04193500). */
export const usgsWater = {
  source: 'usgs-water',
  metrics: ['river_discharge', 'river_gage_height'],
  places: 'places with refs.usgs (a monitoring location id, e.g. USGS-04193500)',
  async fetch({ fetch: f, now, places, src }) {
    const source = src('usgs-water');
    const out = [];
    for (const pl of places.filter((p) => p.refs?.usgs)) {
      const gauge = pl.refs.usgs;
      const url = `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&monitoring_location_id=${gauge}&limit=50`;
      const data = await getJson(f, url);
      for (const feat of data.features || []) {
        const p = feat.properties || {};
        const param = USGS_PARAMETERS[p.parameter_code];
        if (!param || p.value == null || p.value === '') continue;
        const [lng, lat] = feat.geometry?.coordinates || [];
        const place = { ...pl, name: pl.name || gauge, lat: Number.isFinite(pl.lat) ? pl.lat : lat, lng: Number.isFinite(pl.lng) ? pl.lng : lng };
        const at = new Date(p.time);
        const day = localDate(at);
        out.push(reading({
          source, id: `${gauge}:${p.parameter_code}:${day}`, at: at.toISOString(), metric: `river_${param.name}`, place,
          value: p.value, unit: p.unit_of_measure || param.unit,
          summary: `${place.name}: ${param.name.replace('_', ' ')} ${p.value} ${p.unit_of_measure || param.unit} at ${at.toISOString()} (${p.approval_status || 'unknown status'})`,
          fields: { gauge, parameter_code: p.parameter_code, approval_status: p.approval_status ?? null },
          url: `https://waterdata.usgs.gov/monitoring-location/${gauge}/`, fetchedAt: now.toISOString(),
        }));
      }
    }
    return { status: 'ok', readings: out };
  },
};

export const GREAT_LAKES = {
  Erie: { id: 'lake-erie', name: 'Lake Erie (lake-wide)', lat: 42.2, lng: -81.2 },
  Huron: { id: 'lake-huron', name: 'Lake Huron (lake-wide)', lat: 44.8, lng: -82.4 },
  Michigan: { id: 'lake-michigan', name: 'Lake Michigan (lake-wide)', lat: 44.0, lng: -87.0 },
  Superior: { id: 'lake-superior', name: 'Lake Superior (lake-wide)', lat: 47.7, lng: -87.5 },
  St_Clair: { id: 'lake-st-clair', name: 'Lake St. Clair (lake-wide)', lat: 42.45, lng: -82.7 },
  GL_Total: { id: 'great-lakes', name: 'Great Lakes total', lat: 45.0, lng: -84.5 },
};
// glerlIce has no 'Ontario' variable (checked 2026-10-10: Erie, Huron, Michigan,
// Superior, St_Clair, GL_Total, and an undocumented 'America'), so Lake Ontario
// is not offered rather than guessed at.

/** Lake-wide ice concentration (four Great Lakes, Lake St. Clair, all-lakes total), last 21 days. Published roughly Dec–May. */
export const glerlIce = {
  source: 'glerl',
  metrics: ['lake_ice_cover'],
  places: 'fixed: Erie, Huron, Michigan, Superior, St. Clair, and the all-lakes total',
  async fetch({ fetch: f, now, src }) {
    const source = src('glerl');
    const lakes = Object.keys(GREAT_LAKES);
    const since = localDate(new Date(now.getTime() - 21 * 86400000));
    const url = `https://apps.glerl.noaa.gov/erddap/tabledap/glerlIce.json?time%2C${lakes.join('%2C')}&time%3E%3D${since}`;
    let data;
    try {
      data = await getJson(f, url);
    } catch (e) {
      // ERDDAP answers 404 "no matching results" between spring melt and the first ice analysis.
      if (e.status === 404 && /actual_range|no matching results/i.test(e.body || '')) {
        return { status: 'off_season', readings: [], detail: 'no ice analysis published in the last 21 days' };
      }
      throw e;
    }
    const cols = data.table?.columnNames || ['time', ...lakes];
    const out = [];
    for (const row of data.table?.rows || []) {
      const day = String(row[0]).slice(0, 10);
      cols.slice(1).forEach((lake, i) => {
        const v = row[i + 1];
        const place = GREAT_LAKES[lake];
        if (v == null || !place) return;
        out.push(reading({
          source, id: `${place.id}:${day}`, at: day, metric: 'lake_ice_cover', place,
          value: v, unit: 'percent',
          summary: `${place.name.replace(' (lake-wide)', '')} ice cover ${day}: ${v}% (lake-wide, GLERL/NIC analysis)`,
          fields: { dataset: 'glerlIce', scope: 'lake-wide' },
          url: 'https://www.glerl.noaa.gov/data/ice/', fetchedAt: now.toISOString(),
        }));
      });
    }
    return { status: out.length ? 'ok' : 'off_season', readings: out };
  },
};
