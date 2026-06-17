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

    // ---- Per-area day strips + recommended incentive windows ----
    // Incentives are assigned as contiguous SHIFT BLOCKS (see driver UI), and demand
    // is a gradient, so the useful unit is a window, not a scattered 30-min cell.
    // For each area we lay out the day in order, score each cell, and detect runs of
    // under-served / over-served cells (bridging a single soft cell so a one-bucket dip
    // doesn't split a real block), then mark where each window peaks.
    const strips = buildStrips(scored);

    return {
      buckets: scored,
      addList,
      pullList,
      watchList,
      areaRollup,
      strips,
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

  // Classify a single bucket's staffing state for strip purposes.
  // Returns 'under' (breaching -> needs drivers), 'over' (clearly over-served),
  // or 'ok'. Low-sample cells are 'ok' (not actionable) but kept visible as faint.
  function stripState(b) {
    if (b.lowSample) return "lowsample";
    if (b.breaches.length > 0) return "under";
    if (b.load < TARGETS.load * 0.7 && b.wait < TARGETS.wait * 0.85 && b.cancel < TARGETS.cancel * 0.7) return "over";
    return "ok";
  }

  function buildStrips(scored) {
    const byArea = {};
    for (const b of scored) (byArea[b.area] = byArea[b.area] || []).push(b);

    const strips = [];
    for (const [area, list] of Object.entries(byArea)) {
      list.sort((a, b) => (a.hour < b.hour ? -1 : 1));
      const cells = list.map((b) => ({
        hour: b.hour, severity: b.severity, state: stripState(b),
        wait: b.wait, load: b.load, cancel: b.cancel, count: b.count,
        breaches: b.breaches, lowSample: b.lowSample,
      }));

      // ONE anchor per area, always. The single best contiguous window to put an
      // incentive block over — chosen to capture the day's real pressure, not faint
      // marginal stretches.
      const anchor = bestAnchor(cells);
      // One optional reclaim hint: the single clearly over-served block, if any.
      const reclaim = bestReclaim(cells);

      const trips = list.reduce((s, b) => s + b.count, 0);
      strips.push({ area, cells, anchor, reclaim, trips });
    }
    // Most actionable first: by the anchor's intensity (a calm area's anchor is weak).
    strips.sort((a, b) => (b.anchor ? b.anchor.score : 0) - (a.anchor ? a.anchor.score : 0));
    return strips;
  }

  // Find the single best window to anchor an incentive block over.
  // Approach: a window is a contiguous span. We score candidate spans by the SUM of
  // positive over-target severity inside them (so a span is only as good as the real
  // pressure it contains), then pick the highest-scoring span, trimming faint edges so
  // the window hugs the actual hot stretch rather than bleeding into pale cells.
  // Always returns one anchor (even on a calm day -> the relative-worst stretch),
  // flagged weak/strong so the UI can tone it down when it's mild.
  function bestAnchor(cells) {
    const n = cells.length;
    if (!n) return null;
    // sev of a cell only counts if it's actually over target (breaching). Otherwise 0.
    const cellSev = cells.map((c) => (c.lowSample ? 0 : (c.breaches.length > 0 ? c.severity : 0)));

    // If literally nothing breaches, fall back to the single most-pressured cell's
    // neighborhood so we still always emit one anchor (the relative worst).
    const anyBreach = cellSev.some((v) => v > 0);
    const scoreArr = anyBreach ? cellSev : cells.map((c) => (c.lowSample ? 0 : c.severity + 0.001));

    // Best contiguous span maximizing summed score, with a mild length preference so we
    // don't return a 1-cell spike when a coherent block exists. We cap span length so an
    // "always slightly bad" area doesn't return the whole day.
    const MAX_SPAN = 8;   // up to 4 hours
    const MIN_SPAN = 2;   // at least 1 hour
    let best = null;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let len = 1; len <= MAX_SPAN && i + len <= n; len++) {
        sum += scoreArr[i + len - 1];
        if (len < MIN_SPAN) continue;
        // average density rewards tight hot blocks; small length bonus avoids 1-cell wins
        const density = sum / len;
        const score = sum * 0.7 + density * len * 0.3;
        if (!best || score > best.score) best = { start: i, end: i + len - 1, sum, score };
      }
    }
    if (!best) best = { start: 0, end: Math.min(MIN_SPAN, n) - 1, sum: 0, score: 0 };

    // Trim faint edge cells: shrink the window inward while the edge cell carries
    // little of the window's pressure (so the window hugs the real hot stretch).
    const edgeFaint = (idx) => scoreArr[idx] < (best.sum / (best.end - best.start + 1)) * 0.4;
    while (best.end > best.start && edgeFaint(best.end)) best.end--;
    while (best.start < best.end && edgeFaint(best.start)) best.start++;

    const run = cells.slice(best.start, best.end + 1);
    const peak = run.reduce((m, c) => (c.severity > m.severity ? c : m), run[0]);
    const maxSev = peak.severity;
    const breachCount = run.filter((c) => c.breaches.length > 0).length;
    return {
      start: run[0].hour,
      end: addHalfHour(run[run.length - 1].hour),
      peakHour: peak.hour,
      maxSeverity: maxSev,
      breachCount,
      score: best.score,
      // tier hint: strong if the peak is genuinely severe, weak/minor if the whole
      // window is mild (the "calm day, here's the relative worst" case).
      strength: maxSev > 0.5 ? "strong" : (maxSev > 0.18 ? "moderate" : "minor"),
      real: anyBreach && breachCount >= 1,
    };
  }

  // The single clearly over-served block (for the reclaim hint), or null. Requires a
  // real run of comfortably-under cells so we don't suggest reclaiming from noise.
  function bestReclaim(cells) {
    let best = null, i = 0;
    while (i < cells.length) {
      if (cells[i].state !== "over") { i++; continue; }
      let j = i;
      while (j + 1 < cells.length && cells[j + 1].state === "over") j++;
      const len = j - i + 1;
      if (len >= 3 && (!best || len > best.len)) {
        best = { start: cells[i].hour, end: addHalfHour(cells[j].hour), len };
      }
      i = j + 1;
    }
    return best;
  }

  // "18:00" -> "18:30", "18:30" -> "19:00" — for expressing a window's exclusive end.
  function addHalfHour(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    let nh = h, nm = m + 30;
    if (nm >= 60) { nm -= 60; nh += 1; }
    return String(nh).padStart(2, "0") + ":" + String(nm).padStart(2, "0");
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

    const T = TARGETS;
    // A "problem" = breaching ANY target. We evaluate it for today and for the prior median.
    const breachesVals = (wait, load, cancel) => {
      const list = [];
      if (wait > T.wait) list.push("wait");
      if (cancel > T.cancel) list.push("cancel");
      if (load > T.load) list.push("load");
      return list;
    };

    for (const b of todayAnalysis.buckets) {
      const k = b.area + "|" + b.hour;
      const e = priorBucketsByKey[k];
      if (!e) { b.comparison = null; continue; }
      const medWait = median(e.wait), medLoad = median(e.load), medCancel = median(e.cancel);
      b.comparison = {
        weeks: e.wait.length,
        medWait, medLoad, medCancel,
        dWait: b.wait - (medWait ?? b.wait),
        dLoad: b.load - (medLoad ?? b.load),
        dCancel: b.cancel - (medCancel ?? b.cancel),
      };

      // Transition state — only meaningful for buckets with adequate volume today.
      const wasProblem = breachesVals(medWait, medLoad, medCancel).length > 0;
      const isProblem = b.breaches.length > 0;
      let state = "stable";        // fine then, fine now
      if (!wasProblem && isProblem) state = "new";        // newly broken
      else if (wasProblem && !isProblem) state = "fixed"; // recovered
      else if (wasProblem && isProblem) {
        // Persisting — getting worse or better? Use the weighted severity of today vs the
        // prior median, on the SAME severity scale used elsewhere, so "worse" is consistent.
        const sevToday = severity(b);
        const sevThen = severity({ wait: medWait, load: medLoad, cancel: medCancel });
        state = sevToday > sevThen + 0.02 ? "worse" : (sevToday < sevThen - 0.02 ? "better" : "persisting_flat");
      }
      b.transition = b.lowSample ? "lowsample" : state;
      b.wasProblem = wasProblem;
    }

    // Build grouped transition lists for the report. Sorted so the most actionable lead.
    const withCmp = todayAnalysis.buckets.filter((b) => b.comparison && !b.lowSample);
    const sevNow = (b) => severity(b);
    todayAnalysis.transitions = {
      newlyBroken: withCmp.filter((b) => b.transition === "new").sort((a, b) => sevNow(b) - sevNow(a)),
      worsening:   withCmp.filter((b) => b.transition === "worse").sort((a, b) => sevNow(b) - sevNow(a)),
      improving:   withCmp.filter((b) => b.transition === "better").sort((a, b) => sevNow(b) - sevNow(a)),
      flat:        withCmp.filter((b) => b.transition === "persisting_flat").sort((a, b) => sevNow(b) - sevNow(a)),
      fixed:       withCmp.filter((b) => b.transition === "fixed").sort((a, b) => (b.comparison.medWait) - (a.comparison.medWait)),
    };
    todayAnalysis.transitionSummary = {
      newlyBroken: todayAnalysis.transitions.newlyBroken.length,
      worsening: todayAnalysis.transitions.worsening.length,
      improving: todayAnalysis.transitions.improving.length,
      flat: todayAnalysis.transitions.flat.length,
      fixed: todayAnalysis.transitions.fixed.length,
    };
    return todayAnalysis;
  }

  const api = { analyzeDay, attachComparison, toBuckets, TARGETS, VOLUME_FLOOR, COL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Analysis = api;
})(typeof window !== "undefined" ? window : globalThis);
