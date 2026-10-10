/**
 * USGS earthquakes, worldwide, from the real-time GeoJSON summary feeds.
 * Keyless; US government work (public domain).
 * https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php
 *
 * Each event is its own place (the epicentre). params.window picks the feed:
 * hour | day (default) | week; params.min picks the magnitude floor:
 * all (default) | 1.0 | 2.5 | 4.5 | significant.
 */

import { reading } from '../contract.js';
import { getJson } from './http.js';

const WINDOWS = new Set(['hour', 'day', 'week']);
const FLOORS = { all: 'all', '1.0': '1.0', '2.5': '2.5', '4.5': '4.5', significant: 'significant' };

export const usgsEarthquakes = {
  source: 'usgs-earthquakes',
  metrics: ['earthquake'],
  places: 'none needed: every event carries its epicentre',
  params: { window: [...WINDOWS], min: Object.keys(FLOORS) },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('usgs-earthquakes');
    const window = WINDOWS.has(params.window) ? params.window : 'day';
    const floor = FLOORS[params.min] || 'all';
    const data = await getJson(f, `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${floor}_${window}.geojson`);
    const out = [];
    for (const ft of data.features || []) {
      const p = ft.properties || {};
      const [lng, lat, depthKm] = ft.geometry?.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(p.time)) continue;
      out.push(reading({
        source, id: ft.id, at: new Date(p.time).toISOString(), metric: 'earthquake',
        place: { id: `eq-${ft.id}`, name: p.place || 'unnamed location', lat, lng },
        value: p.mag, unit: p.magType ? `magnitude (${p.magType})` : 'magnitude',
        summary: `M${p.mag ?? '?'} ${p.place || ''}${Number.isFinite(depthKm) ? `, ${Math.round(depthKm * 10) / 10} km deep` : ''}${p.tsunami ? ', tsunami flag set' : ''}`.trim(),
        fields: { depth_km: depthKm ?? null, status: p.status ?? null, alert: p.alert ?? null, tsunami: !!p.tsunami, felt: p.felt ?? null, sig: p.sig ?? null, type: p.type ?? null },
        url: p.url || 'https://earthquake.usgs.gov/earthquakes/map/', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
