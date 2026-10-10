/**
 * Every fetcher, by catalog source id. A fetcher is
 *   { source, metrics, places, params?, fetch(ctx) → { status, readings, detail? } }
 * where ctx = { fetch, env, now, places, params, src(id) → catalog entry }
 * and status is one of
 *   ok              readings were produced
 *   off_season      the upstream answered and has nothing for this time of year
 *   not_configured  a key this source needs is not set (said so, never an empty "ok")
 * Anything else throws.
 */

import { openMeteo, waterfowlWsi } from './open-meteo.js';
import { coops, usgsWater, glerlIce } from './water.js';
import { ebird } from './ebird.js';
import { usdaNass } from './usda-nass.js';
import { usgsEarthquakes } from './usgs-earthquakes.js';
import { usgsVolcanoes, noaaNwps } from './hazards.js';
import { epaEcho } from './epa-echo.js';
import { openfdaRecalls, usaspendingAwards } from './business.js';
import { gbif } from './gbif.js';
import { nasaEonet, worldBank } from './global.js';

export const FETCHERS = Object.fromEntries(
  [openMeteo, waterfowlWsi, coops, usgsWater, glerlIce, ebird, usdaNass, usgsEarthquakes, usgsVolcanoes, noaaNwps, epaEcho, openfdaRecalls, usaspendingAwards, gbif, nasaEonet, worldBank].map((x) => [x.source, x]),
);
