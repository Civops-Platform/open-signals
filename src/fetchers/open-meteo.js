/**
 * Open-Meteo daily weather (92 days back, 7 forward) and the duck Weather
 * Severity Index computed from it.
 *
 * Terms: Open-Meteo data is CC BY 4.0, but the free API is for non-commercial
 * use; commercial use needs their paid API. The WSI inherits that.
 * Ported from Civops-Platform/signals src/pipelines/waterfowl/sources.js.
 */

import { reading } from '../contract.js';
import { getJson, localDate, r1 } from './http.js';
import { computeWsi, wsiStatus, WSI_THRESHOLDS } from './wsi.js';

const DAILY = [
  'temperature_2m_mean', 'temperature_2m_min', 'temperature_2m_max', 'snow_depth_max', 'snowfall_sum',
  'precipitation_sum', 'wind_speed_10m_max', 'wind_direction_10m_dominant', 'pressure_msl_mean',
];

// Dominant wind from the northwest round to the northeast.
const isNorthWind = (deg) => deg != null && (deg >= 300 || deg <= 60);

function parseDaily(data) {
  const d = data.daily || {};
  const days = (d.time || []).map((date, i) => ({
    date,
    temp_mean_c: d.temperature_2m_mean?.[i],
    temp_min_c: d.temperature_2m_min?.[i],
    temp_max_c: d.temperature_2m_max?.[i],
    snow_depth_cm: d.snow_depth_max?.[i] == null ? null : d.snow_depth_max[i] * 100, // metres → cm
    snowfall_cm: d.snowfall_sum?.[i],
    precip_mm: d.precipitation_sum?.[i],
    wind_max_kmh: d.wind_speed_10m_max?.[i],
    wind_dir_deg: d.wind_direction_10m_dominant?.[i],
    pressure_hpa: d.pressure_msl_mean?.[i],
  }));
  return { days, timezone: data.timezone || 'UTC' };
}

const url = (ps) => `https://api.open-meteo.com/v1/forecast?latitude=${ps.map((p) => p.lat).join(',')}&longitude=${ps.map((p) => p.lng).join(',')}`
  + `&daily=${DAILY.join(',')}&past_days=92&forecast_days=7&timezone=auto`;

export async function dailyWeather(f, place) {
  return parseDaily(await getJson(f, url([place])));
}

/**
 * Many places in one request per 50: Open-Meteo takes comma-separated coordinates and answers with
 * a list. One request per place ran into its per-minute limit on a layer of every hub.
 */
export async function dailyWeatherMany(f, places) {
  const out = [];
  for (let i = 0; i < places.length; i += 50) {
    const data = await getJson(f, url(places.slice(i, i + 50)), {}, 30000);
    out.push(...(Array.isArray(data) ? data : [data]).map(parseDaily));
  }
  return out;
}

export const openMeteo = {
  source: 'open-meteo',
  metrics: ['weather_daily'],
  places: 'any place with lat/lng',
  async fetch({ fetch: f, now, places, src }) {
    const source = src('open-meteo');
    const out = [];
    const weather = await dailyWeatherMany(f, places);
    for (const [k, p] of places.entries()) {
      const { days, timezone } = weather[k];
      const today = localDate(now, timezone);
      days.forEach((day, i) => {
        const forecast = day.date >= today; // today is still incomplete
        const prev = days[i - 1];
        const pressureChange = prev?.pressure_hpa != null && day.pressure_hpa != null ? r1(day.pressure_hpa - prev.pressure_hpa) : null;
        out.push(reading({
          source, id: `${p.id}:${day.date}`, at: day.date, metric: 'weather_daily', place: p, forecast,
          value: day.temp_mean_c, unit: 'degC',
          summary: `${p.name} ${day.date}${forecast ? ' (forecast)' : ''}: mean ${r1(day.temp_mean_c)}°C, `
            + `wind ${r1(day.wind_max_kmh)} km/h from ${day.wind_dir_deg ?? '?'}°, pressure ${r1(day.pressure_hpa)} hPa`
            + (pressureChange != null ? ` (${pressureChange >= 0 ? '+' : ''}${pressureChange})` : '')
            + (day.snow_depth_cm ? `, snow ${r1(day.snow_depth_cm)} cm` : ''),
          fields: { ...day, pressure_change_hpa: pressureChange, north_wind: isNorthWind(day.wind_dir_deg), model: 'open-meteo best_match' },
          url: 'https://open-meteo.com/en/docs', fetchedAt: now.toISOString(),
        }));
      });
    }
    return { status: 'ok', readings: out };
  },
};

export const waterfowlWsi = {
  source: 'waterfowl-wsi',
  metrics: ['waterfowl_wsi'],
  places: 'any place with lat/lng (meaningful in waterfowl habitat)',
  async fetch({ fetch: f, now, places, src }) {
    const source = src('waterfowl-wsi');
    const out = [];
    const weather = await dailyWeatherMany(f, places);
    for (const [k, p] of places.entries()) {
      const { days, timezone } = weather[k];
      const today = localDate(now, timezone);
      computeWsi(days).forEach((w) => {
        if (w.wsi == null) return;
        const forecast = w.date >= today;
        const st = wsiStatus(w.wsi);
        out.push(reading({
          source, id: `${p.id}:${w.date}`, at: w.date, metric: 'waterfowl_wsi', place: p, forecast,
          value: w.wsi, unit: 'index',
          summary: `${p.name} ${w.date}${forecast ? ' (forecast)' : ''}: WSI ${w.wsi}`
            + (st.mallard_past_threshold ? ' — past the mallard threshold (7.2)'
              : st.other_dabblers_past_threshold ? ' — past the small-dabbler threshold (−4.6), below mallard (7.2)'
              : ' — below both thresholds'),
          fields: { ...w, thresholds: WSI_THRESHOLDS, ...st, inputs: 'open-meteo', method: 'Schummer et al. 2010, JWM 74(1):94-101' },
          url: 'https://research.fs.usda.gov/treesearch/36496', fetchedAt: now.toISOString(),
        }));
      });
    }
    return { status: 'ok', readings: out };
  },
};
