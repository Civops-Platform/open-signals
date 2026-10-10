/**
 * The catalogue: sources (catalog/sources.json), hubs (catalog/hubs.json) and
 * named places (catalog/places.json). Loaded once and validated; a bad entry is
 * a startup error, not a silent skip.
 */

import { readFileSync } from 'node:fs';
import { LICENSES } from './contract.js';

const root = new URL('../catalog/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, root), 'utf8'));

export const SOURCES = load('sources.json').sources;
export const HUBS = load('hubs.json').hubs;
export const PLACES = load('places.json').places;

const byId = new Map(SOURCES.map((s) => [s.id, s]));

export function source(id) {
  const s = byId.get(id);
  if (!s) throw new Error(`unknown source '${id}'`);
  return s;
}

/** Problems with the catalogue, as strings; [] when it is valid. */
export function validateCatalog({ sources = SOURCES, places = PLACES, fetchers = {} } = {}) {
  const errs = [];
  const seen = new Set();
  for (const s of sources) {
    const at = `source '${s.id}'`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id || '')) errs.push(`${at}: id must be lowercase kebab-case`);
    if (seen.has(s.id)) errs.push(`${at}: duplicate id`);
    seen.add(s.id);
    for (const k of ['name', 'homepage', 'coverage', 'license_note']) if (!s[k]) errs.push(`${at}: ${k} missing`);
    if (!LICENSES.includes(s.license)) errs.push(`${at}: license must be one of ${LICENSES.join(', ')}`);
    if (!Array.isArray(s.topics) || !s.topics.length) errs.push(`${at}: topics missing`);
    if (!Array.isArray(s.found_via) || !s.found_via.length) errs.push(`${at}: found_via missing`);
    if (s.fetcher != null && !fetchers[s.fetcher]) errs.push(`${at}: fetcher '${s.fetcher}' does not exist`);
  }
  for (const id of Object.keys(fetchers)) if (!byId.has(id)) errs.push(`fetcher '${id}' has no catalogue entry`);
  const pids = new Set();
  for (const p of places) {
    if (pids.has(p.id)) errs.push(`place '${p.id}': duplicate id`);
    pids.add(p.id);
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) errs.push(`place '${p.id}': lat/lng missing`);
  }
  return errs;
}

/** Filter sources by free text, topic, licence and whether a fetcher exists. */
export function searchSources({ query, topic, license, fetchable } = {}, sources = SOURCES) {
  const q = query?.trim().toLowerCase();
  return sources.filter((s) => {
    if (topic && !s.topics.includes(topic)) return false;
    if (license && s.license !== license) return false;
    if (fetchable != null && fetchable !== '' && Boolean(s.fetcher) !== (fetchable === true || fetchable === 'true')) return false;
    if (q) {
      const hay = [s.id, s.name, s.coverage, s.license_note, ...s.topics].join(' ').toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export const topics = (sources = SOURCES) => [...new Set(sources.flatMap((s) => s.topics))].sort();
