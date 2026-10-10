/**
 * Cumulative Weather Severity Index (CumulativeWSI) for dabbling ducks.
 *
 * Schummer, M.L., Kaminski, R.M., Raedeke, A.H., Graber, D.A. (2010).
 * Weather-related indices of autumn–winter dabbling duck abundance in middle
 * North America. Journal of Wildlife Management 74(1):94–101, Table 2.
 * https://research.fs.usda.gov/treesearch/36496
 *
 * Computed daily as TEMP + TEMPDAYS + SNOW + SNOWDAYS, where
 *   TEMP     = −(daily mean temperature, °C)   (below 0 °C counts as more severe)
 *   TEMPDAYS = consecutive days, ending today, with mean temperature ≤ 0 °C
 *   SNOW     = snow depth in cm × 0.394        (i.e. inches)
 *   SNOWDAYS = consecutive days, ending today, with ≥ 2.54 cm of snow
 *
 * The paper's own worked example (temps 2, −1, −5 °C; snow 0, 3, 26 cm) gives
 * −2, 4 and 19; the test suite asserts exactly that.
 *
 * Thresholds from the same paper (Missouri, 1995–2005): above WSI 7.2 mallard
 * abundance starts falling; other dabblers start leaving above −4.6. They were
 * fit in Missouri. Treat them as a prior elsewhere, not as calibrated truth.
 */

export const WSI_THRESHOLDS = Object.freeze({ mallard: 7.2, other_dabblers: -4.6 });

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * @param {{date: string, temp_mean_c: number|null, snow_depth_cm: number|null}[]} days
 *   Consecutive daily records, oldest first.
 * @returns One entry per input day. A day with no temperature gets wsi null and
 *   breaks both streaks; a missing day is never assumed frozen.
 */
export function computeWsi(days) {
  let tempDays = 0;
  let snowDays = 0;
  return days.map((d) => {
    const t = num(d.temp_mean_c);
    const s = num(d.snow_depth_cm);
    if (t == null) {
      tempDays = 0;
      snowDays = 0;
      return { date: d.date, wsi: null, temp: null, temp_days: null, snow: null, snow_days: null, temp_mean_c: null, snow_depth_cm: s };
    }
    tempDays = t <= 0 ? tempDays + 1 : 0;
    // Missing snow depth with a positive mean temperature is zero (the paper's
    // own estimation rule); missing with a freezing mean is unknown, so it ends
    // the snow streak and contributes nothing rather than guessing.
    const snowCm = s ?? (t > 0 ? 0 : null);
    snowDays = snowCm != null && snowCm >= 2.54 ? snowDays + 1 : 0;
    const temp = -t;
    const snow = snowCm == null ? 0 : snowCm * 0.394;
    return {
      date: d.date,
      wsi: round(temp + tempDays + snow + snowDays),
      temp: round(temp),
      temp_days: tempDays,
      snow: round(snow),
      snow_days: snowDays,
      temp_mean_c: t,
      snow_depth_cm: snowCm,
    };
  });
}

export function wsiStatus(wsi) {
  if (wsi == null) return null;
  return {
    mallard_past_threshold: wsi > WSI_THRESHOLDS.mallard,
    other_dabblers_past_threshold: wsi > WSI_THRESHOLDS.other_dabblers,
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
