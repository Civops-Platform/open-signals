import { source } from '../src/catalog.js';

export const NOW = new Date('2026-10-10T15:00:00Z'); // 11:00 in Ohio

export function res(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

/** fetch stub: [[regex, reply | (url, init) => reply]], records calls, throws on anything unrouted. */
export function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [re, reply] of routes) if (re.test(url)) return typeof reply === 'function' ? reply(url, init) : reply;
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

export const ctx = (fetch, extra = {}) => ({ fetch, env: {}, now: NOW, places: [], params: {}, src: source, ...extra });

export const omDaily = {
  timezone: 'America/New_York',
  daily: {
    time: ['2026-10-09', '2026-10-10', '2026-10-11'],
    temperature_2m_mean: [-1, -2, 3], temperature_2m_min: [-4, -5, 0], temperature_2m_max: [2, 1, 6],
    snow_depth_max: [0.03, 0.05, 0], snowfall_sum: [1, 2, 0], precipitation_sum: [1, 2, 0],
    wind_speed_10m_max: [30, 25, 10], wind_direction_10m_dominant: [330, 20, 180], pressure_msl_mean: [1010, 1018, 1012],
  },
};

export const quakes = {
  features: [
    { id: 'us7000abcd', geometry: { coordinates: [-122.8, 38.8, 2.1] }, properties: { mag: 2.4, magType: 'md', place: '5 km NW of The Geysers, CA', time: Date.parse('2026-10-10T14:00:00Z'), url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd', status: 'automatic', tsunami: 0, sig: 89, type: 'earthquake' } },
    { id: 'bad', geometry: { coordinates: [null, null] }, properties: { mag: 1, time: Date.parse('2026-10-10T13:00:00Z') } },
  ],
};
