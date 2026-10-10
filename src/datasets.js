/**
 * Static datasets: GeoJSON copies of public data that does not change by the minute (burn
 * perimeters, public-land share, campgrounds, station lists). They live outside the repository in
 * OPEN_SIGNALS_DATA_DIR, described by its index.json:
 *
 *   { "datasets": [ { id, label, kind, part_by: "state" | null, description, source, license,
 *                     license_note, generated, built, features, parts: { "OH": "fire_perimeters/OH.geojson", ... } } ] }
 *
 * A part is one file; part_by "state" means one file per two-letter state, null means a single
 * part called "all". The same licence gate as readings applies, and a path can only be one the
 * index names, so nothing outside the data directory is ever read.
 */

import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { servable, LICENSES } from './contract.js';
import { HttpError } from './errors.js';

export function loadDatasets(dir = process.env.OPEN_SIGNALS_DATA_DIR) {
  if (!dir || !existsSync(path.join(dir, 'index.json'))) return { dir: null, datasets: [] };
  const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const datasets = (index.datasets || []).filter((d) => d.id && d.parts && LICENSES.includes(d.license));
  return { dir, datasets };
}

export function createDatasets({ dir, env = process.env } = {}) {
  const { dir: root, datasets } = loadDatasets(dir);
  const byId = new Map(datasets.map((d) => [d.id, d]));

  const describe = (d) => ({
    id: d.id, label: d.label, kind: d.kind, part_by: d.part_by ?? null, description: d.description,
    source: d.source, license: d.license, license_note: d.license_note, generated: d.generated, built: d.built,
    features: d.features, parts: Object.keys(d.parts).sort(), available: servable(d.license, env),
  });

  function list() { return datasets.map(describe); }

  function get(id) {
    const d = byId.get(id);
    if (!d) throw new HttpError(404, `unknown dataset '${id}'`, { datasets: [...byId.keys()] });
    return describe(d);
  }

  /** { file, size } for one part, after the licence gate. */
  function part(id, partId) {
    const d = byId.get(id);
    if (!d) throw new HttpError(404, `unknown dataset '${id}'`, { datasets: [...byId.keys()] });
    if (!servable(d.license, env)) throw new HttpError(451, `dataset '${id}' is licensed '${d.license}' and this server does not republish it`);
    const key = String(partId || 'all').toUpperCase() === 'ALL' ? 'all' : String(partId).toUpperCase();
    const rel = d.parts[key];
    if (!rel) throw new HttpError(404, `dataset '${id}' has no part '${partId}'`, { parts: Object.keys(d.parts).sort() });
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new HttpError(404, 'not found');
    return { file, size: statSync(file).size };
  }

  return { list, get, part, stream: (file) => createReadStream(file) };
}
