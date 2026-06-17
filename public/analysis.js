// ============================================================================
// analysis.js — the analytical core. Pure functions, no DOM, no network.
// Runs in the browser (loaded by index.html) AND is testable in Node.
// ============================================================================
//
// What it does, in plain terms:
//   - Each row is one (area, 30-min bucket): wait time, load, %cancel, count, drivers.
//   - Targets (from the brief): Load <= 1.8, %Cancel <= 30%, Wait <= 12 min.
//     Goal is customer experience = low wait, so WAIT is weighted highest.
//   - We score every bucket's severity over target, and produce two ranked lists:
//       * "Add incentive here" — under-served buckets where bumping driver pay helps.
//       * "Pull incentive here" — over-served buckets (low load + low wait) to reclaim from.
//   - Volume floor: a bucket with very few trips (e.g. Count=3) can show 100% cancel
//     off a single trip. Those are flagged "low sample — watch" and kept OUT of the
//     main action ranking so they don't hijack priorities.
//   - The lever is a soft pay incentive, not hard assignment, so output is a ranked
//     "where it pays off most" — we don't pretend to predict exact driver movement.

(function (root) {
  "use strict";

  const TARGETS = { load: 1.8, cancel: 0.30, wait: 12 }; // cancel is a 0..1 ratio
  const VOLUME_FLOOR = 15; // trips per bucket below this = "low sample", excluded from ranking
  const COL = { hour: "HourString", area: "hop_area_name_en", wait: "avg", load: "avg_2", cancel: "%Cancel", count: "count", drivers: "count_2" };

  // Convert raw {cols, rows} into an array of bucket objects keyed by column NAME,
  // so we're robust to column reordering.
  function toBuckets(cols, rows) {
    const idx = {};
    cols.forEach((c, i) => { idx[c.name] = i; });
    for (const need of Object.values(COL)) {
      if (!(need in idx)) throw new Error(`Expected column "${need}" not found in results.`);
    }
    return rows.map((r) => ({
      hour: r[idx[COL.hour]],
      area: r[idx[COL.area]],
      wait: num(r[idx[COL.wait]]),
      load: num(r[idx[COL.load]]),
      cancel: num(r[idx[COL.cancel]]),
      count: num(r[idx[COL.count]]),
      drivers: num(r[idx[COL.drivers]]),
    }));
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Severity: how far over each target, normalised so the three are comparable,
  // then weighted (wait heaviest because it's the stated goal).
  // A metric at or under target contributes 0. Over target contributes the
  // fractional overage (e.g. wait 18 vs target 12 -> 0.5).
  const WEIGHTS = { wait: 0.5, cancel: 0.3, load: 0.2 };
  function severity(b) {
    const waitOver = Math.max(0, (b.wait - TARGETS.wait) / TARGETS.wait);
    const cancelOver = Math.max(0, (b.cancel - TARGETS.cancel) / TARGETS.cancel);
    const loadOver = Math.max(0, (b.load - TARGETS.load) / TARGETS.load);
    return WEIGHTS.wait * waitOver + WEIGHTS.cancel * cancelOver + WEIGHTS.load * loadOver;
  }

  // Which targets a bucket breaches, as a list of short tags.
  function breaches(b) {
    const out = [];
    if (b.wait > TARGETS.wait) out.push("wait");
    if (b.cancel > TARGETS.cancel) out.push("cancel");
    if (b.load > TARGETS.load) out.push("load");
    return out;
  }

  // Is this bucket a candidate to PULL incentive from? Comfortably under all targets,
  // with enough volume that the "low" isn't just noise.
  function isOverserved(b) {
    return b.count >= VOLUME_FLOOR &&
      b.load < TARGETS.load * 0.7 &&   // load < ~1.26
      b.wait < TARGETS.wait * 0.85 &&  // wait < ~10.2 min
      b.cancel < TARGETS.cancel * 0.7; // cancel < 21%
  }

  // Flag the "incentive won't fix this" case: wait is over target but load is LOW.
  // High wait with low load means the problem isn't too few drivers per trip — paying
  // drivers to show up may not help; it's a different (structural/supply) issue.
  function waitNotLoadDriven(b) {
    return b.wait > TARGETS.wait && b.load < TARGETS.load * 0.8;
  }

  function analyzeDay(cols, rows) {
    const buckets = toBuckets(cols, rows);

    const scored = buckets.map((b) => ({
      ...b,
      severity: severity(b),
      breaches: breaches(b),
      lowSample: b.count < VOLUME_FLOOR,
    }));

    // ADD list: breaches at least one target, has adequate volume, sorted by severity.
    // NOTE: we set structuralFlag on the SAME object (not a copy) so that comparison
    // data attached later (to analysis.buckets) is visible on these rows too.
    const addList = scored
      .filter((b) => b.breaches.length > 0 && !b.lowSample)
      .map((b) => { b.structuralFlag = waitNotLoadDriven(b); return b; })
      .sort((a, b) => b.severity - a.severity);

    // PULL list: over-served, sorted by how over-served (lowest load first).
    const pullList = scored
      .filter((b) => isOverserved(b))
      .sort((a, b) => a.load - b.load);

    // Low-sample watch list: breaches but too few trips to act on confidently.
    const watchList = scored
      .filter((b) => b.breaches.length > 0 && b.lowSample)
      .sort((a, b) => b.severity - a.severity);

    // Per-area rollup: weighted by trip count (volume-weighted averages), so a busy
    // area isn't diluted by its quiet buckets. Tells structural vs peak problems apart.
    const byArea = {};
    for (const b of scored) {
      const a = (byArea[b.area] = byArea[b.area] || { area: b.area, trips: 0, _w: 0, _c: 0, _l: 0, breachBuckets: 0, totalBuckets: 0 });
      a.trips += b.count;
      a._w += b.wait * b.count;
      a._c += b.cancel * b.count;
      a._l += b.load * b.count;
      a.totalBuckets += 1;
      if (b.breaches.length > 0 && !b.lowSample) a.breachBuckets += 1;
    }
    const areaRollup = Object.values(byArea).map((a) => ({
      area: a.area,
      trips: a.trips,
      avgWait: a.trips ? a._w / a.trips : 0,
      avgCancel: a.trips ? a._c / a.trips : 0,
      avgLoad: a.trips ? a._l / a.trips : 0,
      breachBuckets: a.breachBuckets,
      totalBuckets: a.totalBuckets,
    })).sort((x, y) => y.avgWait - x.avgWait);

    return {
      buckets: scored,
      addList,
      pullList,
      watchList,
      areaRollup,
      targets: TARGETS,
      volumeFloor: VOLUME_FLOOR,
      summary: {
        totalBuckets: scored.length,
        totalTrips: scored.reduce((s, b) => s + b.count, 0),
        areas: areaRollup.length,
        addCount: addList.length,
        pullCount: pullList.length,
        watchCount: watchList.length,
        criticalCount: addList.filter((b) => b.severity > 0.5).length,
      },
    };
  }

  // Comparison: given today's buckets and an array of prior-week pulls (same weekday),
  // compute the per-(area,hour) MEDIAN of each metric across those weeks, and attach
  // today-vs-median deltas. Median (not mean) per the brief — washes out a holiday spike.
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function attachComparison(todayAnalysis, priorPulls) {
    // priorPulls: [{cols, rows}, ...] for prior same-weekday dates.
    const priorBucketsByKey = {}; // "area|hour" -> {wait:[], load:[], cancel:[]}
    for (const pull of priorPulls) {
      let pb;
      try { pb = toBuckets(pull.cols, pull.rows); } catch { continue; }
      for (const b of pb) {
        const k = b.area + "|" + b.hour;
        const e = (priorBucketsByKey[k] = priorBucketsByKey[k] || { wait: [], load: [], cancel: [] });
        e.wait.push(b.wait); e.load.push(b.load); e.cancel.push(b.cancel);
      }
    }
    for (const b of todayAnalysis.buckets) {
      const k = b.area + "|" + b.hour;
      const e = priorBucketsByKey[k];
      if (!e) { b.comparison = null; continue; }
      b.comparison = {
        weeks: e.wait.length,
        medWait: median(e.wait), medLoad: median(e.load), medCancel: median(e.cancel),
        dWait: b.wait - (median(e.wait) ?? b.wait),
        dLoad: b.load - (median(e.load) ?? b.load),
        dCancel: b.cancel - (median(e.cancel) ?? b.cancel),
      };
    }
    return todayAnalysis;
  }

  const api = { analyzeDay, attachComparison, toBuckets, TARGETS, VOLUME_FLOOR, COL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof window !== "undefined" ? window : globalThis);
