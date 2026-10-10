/**
 * Natural hazards: USGS volcano alert levels and NOAA river flood status.
 * Both keyless, both US government work (public domain).
 */

import { reading } from '../contract.js';
import { getJson, localDate } from './http.js';

const HANS = 'https://volcanoes.usgs.gov/hans-public/api/volcano';
const ALERT_RANK = { NORMAL: 0, ADVISORY: 1, WATCH: 2, WARNING: 3 };

/**
 * Current aviation colour code and ground alert level for every US volcano the
 * USGS observatories monitor. Positions come from the volcano list (the alert
 * list carries none); a monitored volcano without a position is skipped.
 * params.elevated=true keeps only those above NORMAL/GREEN.
 */
export const usgsVolcanoes = {
  source: 'usgs-volcanoes',
  metrics: ['volcano_alert'],
  places: 'fixed: every monitored US volcano',
  params: { elevated: ['true', 'false'] },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('usgs-volcanoes');
    const [volcanoes, monitored] = await Promise.all([
      getJson(f, `${HANS}/getUSVolcanoes`),
      getJson(f, `${HANS}/getMonitoredVolcanoes`),
    ]);
    const where = new Map(volcanoes.map((v) => [String(v.vnum), v]));
    const out = [];
    for (const m of monitored) {
      const v = where.get(String(m.vnum));
      if (!v || !Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) continue;
      const level = String(m.alert_level || '').toUpperCase();
      const rank = ALERT_RANK[level] ?? null;
      if (params.elevated === 'true' && !(rank > 0)) continue;
      const sent = m.sent_utc ? new Date(m.sent_utc.replace(' ', 'T') + 'Z') : null;
      out.push(reading({
        source, id: `${m.vnum}:${m.notice_identifier || 'current'}`, at: sent && !Number.isNaN(sent.getTime()) ? sent.toISOString() : localDate(now, 'UTC'),
        metric: 'volcano_alert',
        place: { id: `volcano-${m.vnum}`, name: m.volcano_name, lat: v.latitude, lng: v.longitude },
        value: rank, unit: 'alert level (0 normal – 3 warning)',
        summary: `${m.volcano_name} (${v.region || m.obs_abbr?.toUpperCase()}): ${level || 'unknown'} / ${m.color_code || 'unknown'} since ${m.sent_utc || 'unknown'}`,
        fields: { alert_level: level || null, color_code: m.color_code ?? null, observatory: m.obs_fullname ?? null, region: v.region ?? null,
          elevation_m: v.elevation_meters ?? null, threat: v.nvews_threat ?? null, notice_url: m.notice_url ?? null },
        url: m.notice_url || v.volcano_url || 'https://volcanoes.usgs.gov/', fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};

const FLOOD_RANK = { no_flooding: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const DEFAULT_BBOX = [-93, 40, -75, 49]; // Great Lakes basin
const MAX_BBOX_DEG2 = 400;

/** "xmin,ymin,xmax,ymax" → numbers, or throws. Bounded so one call stays small. */
export function parseBbox(v) {
  if (v == null || v === '') return DEFAULT_BBOX;
  const b = String(v).split(',').map(Number);
  const [x0, y0, x1, y1] = b;
  if (b.length !== 4 || b.some((n) => !Number.isFinite(n)) || x0 >= x1 || y0 >= y1 || Math.abs(x0) > 180 || Math.abs(x1) > 180 || Math.abs(y0) > 90 || Math.abs(y1) > 90) {
    throw Object.assign(new Error('bbox must be xmin,ymin,xmax,ymax in degrees'), { status: 400 });
  }
  if ((x1 - x0) * (y1 - y0) > MAX_BBOX_DEG2) throw Object.assign(new Error(`bbox larger than ${MAX_BBOX_DEG2} square degrees`), { status: 400 });
  return b;
}

const num = (v) => (v == null || v === -999 || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * NOAA National Water Prediction Service gauges in a bounding box: observed
 * stage and flow, the flood category it puts the river in, and the forecast
 * category where the river forecast centre issues one.
 */
export const noaaNwps = {
  source: 'noaa-nwps',
  metrics: ['river_flood_status'],
  places: 'gauges inside params.bbox (default: the Great Lakes basin)',
  params: { bbox: 'xmin,ymin,xmax,ymax' },
  async fetch({ fetch: f, now, src, params = {} }) {
    const source = src('noaa-nwps');
    const [x0, y0, x1, y1] = parseBbox(params.bbox);
    const data = await getJson(f, `https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=${x0}&bbox.ymin=${y0}&bbox.xmax=${x1}&bbox.ymax=${y1}&srid=EPSG_4326`, {}, 30000);
    const out = [];
    for (const g of data.gauges || []) {
      const o = g.status?.observed || {};
      const fc = g.status?.forecast || {};
      const stage = num(o.primary);
      if (!Number.isFinite(g.latitude) || !Number.isFinite(g.longitude) || stage == null || !o.validTime || o.validTime.startsWith('0001')) continue;
      const cat = o.floodCategory || null;
      const fcat = fc.floodCategory && !/not_current|fcst_not/.test(fc.floodCategory) && fc.floodCategory !== 'not_defined' ? fc.floodCategory : null;
      out.push(reading({
        source, id: `${g.lid}:${o.validTime}`, at: new Date(o.validTime).toISOString(), metric: 'river_flood_status',
        place: { id: `nwps-${g.lid}`, name: g.name, lat: g.latitude, lng: g.longitude, state: g.state?.abbreviation },
        value: stage, unit: o.primaryUnit || 'ft',
        summary: `${g.name}: ${stage} ${o.primaryUnit || 'ft'}${num(o.secondary) != null ? `, ${num(o.secondary)} ${o.secondaryUnit}` : ''}, ${(cat || 'unknown').replace('_', ' ')}`
          + (fcat ? `; forecast ${fcat.replace('_', ' ')}` : ''),
        fields: { lid: g.lid, flood_category: cat, flood_rank: FLOOD_RANK[cat] ?? null, forecast_category: fcat, forecast_stage: fcat ? num(fc.primary) : null,
          flow: num(o.secondary), flow_unit: o.secondaryUnit || null, forecast_center: g.rfc?.abbreviation ?? null },
        url: `https://water.noaa.gov/gauges/${g.lid}`, fetchedAt: now.toISOString(),
      }));
    }
    return { status: 'ok', readings: out };
  },
};
