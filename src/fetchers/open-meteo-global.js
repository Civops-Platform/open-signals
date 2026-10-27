/**
 * Two global point layers from Open-Meteo, at fixed lists of places committed in catalog/ (built by
 * scripts/build-world-points.mjs), or at the places a caller names.
 *
 *   open-meteo-flood  GloFAS v4 river discharge (Copernicus Emergency Management Service) through the
 *                     Open-Meteo Flood API, at about a hundred large-river locations.
 *   open-meteo-air    CAMS air quality (Copernicus Atmosphere Monitoring Service) through the
 *                     Open-Meteo Air Quality API, at 150 large cities: current PM2.5, PM10, US AQI and
 *                     European AQI.
 *
 * Terms (https://open-meteo.com/en/terms, read 2026-10-10): data CC BY 4.0, the free API for
 * non-commercial use only, under 600 calls a minute. Both ask in one request per 50 places.
 */

import { readFileSync } from 'node:fs';
import { reading } from '../contract.js';
import { getJson, r1 } from './http.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../catalog/${f}`, import.meta.url), 'utf8')).places;
let rivers = null, cities = null;
export const worldRivers = () => (rivers ??= load('world-rivers.json'));
export const worldCities = () => (cities ??= load('world-cities.json'));

const placeable = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);
const coords = (ps) => `latitude=${ps.map((p) => p.lat).join(',')}&longitude=${ps.map((p) => p.lng).join(',')}`;

/** One request per 50 places; Open-Meteo answers a list for several, an object for one. */
async function many(f, base, places) {
  const out = [];
  for (let i = 0; i < places.length; i += 50) {
    const data = await getJson(f, `${base}&${coords(places.slice(i, i + 50))}`, {}, 30000);
    out.push(...(Array.isArray(data) ? data : [data]));
  }
  return out;
}

const FLOOD = 'https://flood-api.open-meteo.com/v1/flood?daily=river_discharge,river_discharge_median,river_discharge_max&past_days=8&forecast_days=30';

export const openMeteoFlood = {
  source: 'open-meteo-flood',
  metrics: ['river_discharge'],
  places: 'about a hundred large-river locations (catalog/world-rivers.json), or any place with lat/lng',
  async fetch({ fetch: f, now, places, src }) {
    const source = src('open-meteo-flood');
    const ps = (places.length ? places : worldRivers()).filter(placeable);
    const data = await many(f, FLOOD, ps);
    const today = now.toISOString().slice(0, 10); // GloFAS days are UTC
    const out = [];
    ps.forEach((p, k) => {
      const d = data[k]?.daily;
      if (!d?.time) return;
      const i = d.time.indexOf(today);
      if (i < 0 || d.river_discharge?.[i] == null) return;
      const q = d.river_discharge[i];
      const med = d.river_discharge_median?.[i] ?? null;
      const weekAgo = i >= 7 ? d.river_discharge[i - 7] : null;
      let peak = null;
      for (let j = i + 1; j < d.time.length; j++) {
        const v = d.river_discharge_max?.[j];
        if (v != null && (!peak || v > peak.value)) peak = { value: v, date: d.time[j] };
      }
      const ratio = med > 0 ? Math.round((q / med) * 100) / 100 : null;
      const change = weekAgo > 0 ? r1(((q - weekAgo) / weekAgo) * 100) : null;
      out.push(reading({
        source, id: `${p.id}:${today}`, at: today, metric: 'river_discharge', place: p, basis: 'modelled',
        value: q, unit: 'm³/s',
        summary: `${p.name} ${today}: ${Math.round(q).toLocaleString('en-US')} m³/s`
          + (change != null ? `, ${change >= 0 ? '+' : ''}${change}% on a week ago` : '')
          + (peak ? `; ensemble high over the next 30 days ${Math.round(peak.value).toLocaleString('en-US')} m³/s (${peak.date})` : ''),
        fields: { discharge_m3s: q, ensemble_median_m3s: med, ensemble_max_m3s: d.river_discharge_max?.[i] ?? null, ratio_to_ensemble_median: ratio,
          week_ago_m3s: weekAgo, change_7d_pct: change, peak_30d_ensemble_max_m3s: peak?.value ?? null, peak_30d_date: peak?.date ?? null,
          river: p.river ?? null, country: p.country ?? null, grid_lat: data[k].latitude, grid_lng: data[k].longitude,
          model: 'GloFAS v4 (seamless)', note: 'The median and max are across GloFAS ensemble members for the day, not a climatology.' },
        url: 'https://open-meteo.com/en/docs/flood-api', fetchedAt: now.toISOString(),
      }));
    });
    return { status: 'ok', readings: out };
  },
};

const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality?current=pm2_5,pm10,us_aqi,european_aqi&timezone=GMT';
const US_AQI = [[50, 'good'], [100, 'moderate'], [150, 'unhealthy for sensitive groups'], [200, 'unhealthy'], [300, 'very unhealthy'], [Infinity, 'hazardous']];
export const usAqiCategory = (v) => (v == null ? null : US_AQI.find(([max]) => v <= max)[1]);

export const openMeteoAir = {
  source: 'open-meteo-air',
  metrics: ['air_quality'],
  places: '150 large cities (catalog/world-cities.json), or any place with lat/lng',
  async fetch({ fetch: f, now, places, src }) {
    const source = src('open-meteo-air');
    const ps = (places.length ? places : worldCities()).filter(placeable);
    const data = await many(f, AIR, ps);
    const out = [];
    ps.forEach((p, k) => {
      const c = data[k]?.current;
      if (!c?.time) return;
      const at = new Date(`${c.time}:00Z`).toISOString();
      const cat = usAqiCategory(c.us_aqi);
      out.push(reading({
        source, id: `${p.id}:${at}`, at, metric: 'air_quality', place: p, basis: 'modelled',
        value: c.us_aqi, unit: 'US AQI',
        summary: `${p.name} ${at.slice(0, 13).replace('T', ' ')}:00 UTC: US AQI ${c.us_aqi ?? '?'}${cat ? ` (${cat})` : ''}, PM2.5 ${r1(c.pm2_5) ?? '?'} µg/m³, PM10 ${r1(c.pm10) ?? '?'} µg/m³, European AQI ${c.european_aqi ?? '?'}`,
        fields: { us_aqi: c.us_aqi ?? null, us_aqi_category: cat, european_aqi: c.european_aqi ?? null, pm2_5_ugm3: c.pm2_5 ?? null, pm10_ugm3: c.pm10 ?? null,
          country: p.country ?? null, model: 'CAMS (European 0.1° over Europe, global 0.4° elsewhere)', modelled: true },
        url: 'https://open-meteo.com/en/docs/air-quality-api', fetchedAt: now.toISOString(),
      }));
    });
    return { status: 'ok', readings: out };
  },
};
