/** ZIP → [lng, lat] from the Census ZCTA gazetteer (catalog/zip-centroids.json, public domain). */
import { readFileSync } from 'node:fs';

let table = null;
export function zipCentroid(zip) {
  if (!table) table = JSON.parse(readFileSync(new URL('../../catalog/zip-centroids.json', import.meta.url), 'utf8')).zcta;
  const z = String(zip || '').trim().slice(0, 5);
  return /^\d{5}$/.test(z) ? table[z] || null : null;
}
