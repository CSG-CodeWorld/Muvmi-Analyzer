// ============================================================================
// app.js — UI orchestration. Talks to /api/login and /api/pull, runs Analysis,
// renders the report. Holds the session token in sessionStorage so the user
// stays logged in across refreshes (cleared on logout). Password never stored.
// ============================================================================
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "mb_token";
  const USER_KEY = "mb_user";

  // ---- session ----
  function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
  function setSession(token, user) { sessionStorage.setItem(TOKEN_KEY, token); if (user) sessionStorage.setItem(USER_KEY, user); }
  function clearSession() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(USER_KEY); }

  function showApp() {
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    const u = sessionStorage.getItem(USER_KEY);
    $("who").textContent = u ? u : "";
    // default date = yesterday (the typical "how did we do" question)
    const d = new Date(); d.setDate(d.getDate() - 1);
    $("date").value = d.toISOString().slice(0, 10);
  }
  function showLogin() {
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
  }

  // ---- login ----
  async function doLogin() {
    const username = $("u").value.trim();
    const password = $("p").value;
    $("loginErr").textContent = "";
    if (!username || !password) { $("loginErr").textContent = "Enter your email and password."; return; }
    $("loginBtn").disabled = true; $("loginBtn").textContent = "Signing in…";
    try {
      const r = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setSession(j.token, username);
      $("p").value = "";
      showApp();
    } catch (e) {
      $("loginErr").textContent = e.message;
    } finally {
      $("loginBtn").disabled = false; $("loginBtn").textContent = "Sign in";
    }
  }

  function doLogout() { clearSession(); showLogin(); }

  // ---- pulling ----
  // Pull one date. Returns {cols, rows} or throws.
  async function pullDate(date) {
    const r = await fetch("/api/pull", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken(), date }),
    });
    const j = await r.json();
    if (j.error) {
      if (/log in again|Session expired|Not logged in/i.test(j.error)) { clearSession(); showLogin(); }
      throw new Error(j.error);
    }
    return j;
  }

  // Prior same-weekday dates, going back `weeks` weeks.
  function priorWeekdayDates(dateStr, weeks) {
    const out = [];
    const base = new Date(dateStr + "T00:00:00");
    for (let i = 1; i <= weeks; i++) {
      const d = new Date(base); d.setDate(d.getDate() - 7 * i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  // Title-bar progress so a backgrounded tab still shows status, like Metabase does.
  function setTitle(s) { document.title = s ? `${s} — Area Performance` : "Area Performance — MuvMi"; }

  let originalTitle = document.title;
  async function run() {
    const date = $("date").value;
    if (!date) return;
    const compare = $("cmp").checked;

    // Weeks back: free number, clamped to a sane range. Each extra week is one more
    // ~15-20s sequential pull, so warn before a long run.
    const WARN_WEEKS = 6;            // above this, confirm before running
    const MAX_WEEKS = 52;            // hard ceiling
    let weeks = parseInt($("weeks").value, 10);
    if (!Number.isFinite(weeks) || weeks < 1) weeks = 1;
    if (weeks > MAX_WEEKS) weeks = MAX_WEEKS;
    $("weeks").value = weeks;        // reflect the clamp back to the user

    if (compare && weeks > WARN_WEEKS) {
      const totalPulls = weeks + 1;  // today + N prior weeks
      const lowMin = Math.ceil((totalPulls * 15) / 60);
      const highMin = Math.ceil((totalPulls * 20) / 60);
      const ok = window.confirm(
        `That's ${totalPulls} separate queries (today + ${weeks} prior weeks).\n\n` +
        `Each one takes ~15-20 seconds on Metabase, so this run will take roughly ` +
        `${lowMin}-${highMin} minute${highMin > 1 ? "s" : ""}.\n\nRun it anyway?`
      );
      if (!ok) return;
    }

    const dates = [date];
    if (compare) dates.push(...priorWeekdayDates(date, weeks));

    $("runBtn").disabled = true;
    $("progress").classList.add("on");
    $("report").innerHTML = "";
    notifyAsk();

    const pulls = {};
    try {
      for (let i = 0; i < dates.length; i++) {
        const d = dates[i];
        const msg = `Pulling ${d}  (${i + 1} of ${dates.length})`;
        $("progressText").textContent = msg;
        setTitle(`(${i + 1}/${dates.length}) Pulling…`);
        pulls[d] = await pullDate(d);
      }

      $("progressText").textContent = "Analyzing…";
      setTitle("Analyzing…");
      const today = pulls[date];
      const analysis = Analysis.analyzeDay(today.cols, today.rows);
      if (compare) {
        const priors = dates.slice(1).map((d) => pulls[d]).filter(Boolean);
        Analysis.attachComparison(analysis, priors);
      }
      render(analysis, { date, compare, weeks });
      setTitle("✓ Report ready");
      notifyDone(`Analysis for ${date} is ready`);
      setTimeout(() => setTitle(""), 4000);
    } catch (e) {
      $("report").innerHTML = `<div class="action-row add"><div></div><div><div class="area">Couldn't complete the run</div><div class="hour">${escapeHtml(e.message)}</div></div><div></div></div>`;
      setTitle("");
    } finally {
      $("runBtn").disabled = false;
      $("progress").classList.remove("on");
    }
  }

  // ---- browser notification (so backgrounded tab alerts when done) ----
  function notifyAsk() { try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch {} }
  function notifyDone(text) {
    try {
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        new Notification("Area Performance", { body: text });
      }
    } catch {}
  }

  // ---- rendering ----
  const fmt = {
    wait: (v) => v.toFixed(1),
    load: (v) => v.toFixed(2),
    pct: (v) => (v * 100).toFixed(0) + "%",
    int: (v) => Math.round(v).toLocaleString(),
  };
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // Metabase-style green->white->red ramp for a value within [min,max].
  function rampColor(v, min, max) {
    const t = Math.max(0, Math.min(1, (v - min) / (max - min)));
    // 0 -> green (#84BB4C), .5 -> white, 1 -> red (#e0524d)
    const g = [132, 187, 76], w = [245, 245, 245], r = [224, 82, 77];
    let c;
    if (t < 0.5) { const k = t / 0.5; c = g.map((x, i) => Math.round(x + (w[i] - x) * k)); }
    else { const k = (t - 0.5) / 0.5; c = w.map((x, i) => Math.round(x + (r[i] - x) * k)); }
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function deltaSpan(delta, invertGood) {
    // invertGood=true means a NEGATIVE delta is good (lower wait/cancel/load is good).
    if (delta == null || !isFinite(delta)) return "";
    const good = invertGood ? delta < 0 : delta > 0;
    const arrow = delta > 0 ? "▲" : "▼";
    const cls = good ? "down" : "up";
    return `<span class="delta ${cls}">${arrow}${Math.abs(delta).toFixed(delta % 1 ? 1 : 0)}</span>`;
  }

  function render(a, opts) {
    const slides = [];

    // ===== SLIDE 1: OPENING OVERVIEW (overall + week-over-week across all areas) =====
    slides.push({ name: "Overview", html: slideOverview(a, opts) });

    // ===== PER-AREA SLIDES (everything for that area together) =====
    for (const strip of a.strips) {
      slides.push({ name: shortAreaName(strip.area), html: slideArea(strip, a, opts) });
    }

    // ===== CLOSING SLIDE: ACTIONS =====
    slides.push({ name: "Actions", html: slideActions(a, opts) });

    // Build the deck: a nav strip of jump-to buttons + a horizontal scroller.
    let nav = `<div class="deck-nav">`;
    slides.forEach((s, i) => {
      nav += `<button class="deck-tab${i === 0 ? " active" : ""}" data-slide="${i}">${escapeHtml(s.name)}</button>`;
    });
    nav += `</div>`;

    let track = `<div class="deck-track" id="deckTrack">`;
    slides.forEach((s, i) => {
      track += `<div class="slide" data-slide="${i}">${s.html}</div>`;
    });
    track += `</div>`;

    const arrows = `<div class="deck-arrows">
      <button class="deck-arrow" id="deckPrev" aria-label="Previous">‹</button>
      <button class="deck-arrow" id="deckNext" aria-label="Next">›</button>
    </div>`;

    $("report").innerHTML = `<div class="deck">${nav}${arrows}${track}</div>`;
    wireDeck(slides.length);
  }

  // ---- Deck navigation ----
  function wireDeck(count) {
    const track = $("deckTrack");
    let cur = 0;
    const tabs = Array.from(document.querySelectorAll(".deck-tab"));
    const go = (i) => {
      cur = Math.max(0, Math.min(count - 1, i));
      const slide = track.querySelector(`.slide[data-slide="${cur}"]`);
      if (slide) track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: "smooth" });
      tabs.forEach((t, j) => t.classList.toggle("active", j === cur));
    };
    tabs.forEach((t) => t.addEventListener("click", () => go(parseInt(t.dataset.slide, 10))));
    const prev = $("deckPrev"), next = $("deckNext");
    if (prev) prev.addEventListener("click", () => go(cur - 1));
    if (next) next.addEventListener("click", () => go(cur + 1));
    // keyboard arrows
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.key === "ArrowRight") go(cur + 1);
      else if (e.key === "ArrowLeft") go(cur - 1);
    });
    // update active tab on manual scroll
    let scrollTimer;
    track.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const slides = Array.from(track.querySelectorAll(".slide"));
        const mid = track.scrollLeft + track.clientWidth / 2;
        let nearest = 0, nd = Infinity;
        slides.forEach((s, i) => { const c = s.offsetLeft - track.offsetLeft + s.clientWidth / 2; const d = Math.abs(c - mid); if (d < nd) { nd = d; nearest = i; } });
        cur = nearest;
        tabs.forEach((t, j) => t.classList.toggle("active", j === cur));
      }, 90);
    });
  }

  // ---- Slide 1: opening overview ----
  function slideOverview(a, opts) {
    const s = a.summary;
    const wd = weekdayName(opts.date);
    let h = `<div class="slide-inner">
      <div class="eyebrow">${escapeHtml(opts.date)} · ${wd}${opts.compare ? ` · vs median of ${opts.weeks} prior ${wd}s` : ""}</div>
      <h2 class="slide-title">Daily overview</h2>
      <div class="tiles">
        <div class="tile"><div class="n">${fmt.int(s.totalTrips)}</div><div class="l">trips today</div></div>
        <div class="tile"><div class="n">${s.areas}</div><div class="l">areas</div></div>
        <div class="tile ${s.addCount ? "alert" : "good"}"><div class="n">${s.addCount}</div><div class="l">under-served slots</div></div>
        <div class="tile good"><div class="n">${s.pullCount}</div><div class="l">over-served slots</div></div>
      </div>`;

    // City-wide week-over-week, the headline answer to "does it compare to last 3 weeks?"
    if (opts.compare && a.transitionSummary) {
      const ts = a.transitionSummary;
      h += `<h3 class="block-title">Versus recent ${wd}s — across all areas</h3>
        <div class="section-note">How today's area-time slots compare to the median of the prior ${opts.weeks} ${wd}s.</div>
        <div class="tiles wow">
          <div class="tile alert"><div class="n">${ts.newlyBroken}</div><div class="l">newly broken</div></div>
          <div class="tile alert"><div class="n">${ts.worsening}</div><div class="l">getting worse</div></div>
          <div class="tile"><div class="n">${ts.improving}</div><div class="l">improving</div></div>
          <div class="tile"><div class="n">${ts.flat}</div><div class="l">chronic</div></div>
          <div class="tile good"><div class="n">${ts.fixed}</div><div class="l">recovered</div></div>
        </div>`;

      // The cross-area transition lists, each collapsible, so this slide IS the comparison view.
      const t = a.transitions;
      h += `<div class="ov-groups">`;
      h += ovGroup("Newly broken", "Fine on recent " + wd + "s, breaching today.", t.newlyBroken, "add", true);
      h += ovGroup("Getting worse", "Already a problem, worse today than median.", t.worsening, "add", false);
      h += ovGroup("Improving", "Still breaching but better than median.", t.improving, "watch", false);
      h += ovGroup("Chronic", "Breaching then and now, roughly flat.", t.flat, "watch", false);
      h += ovGroup("Recovered", "Was breaching, fine today.", t.fixed, "pull", false);
      h += `</div>`;
    } else {
      h += `<div class="section-note" style="margin-top:18px">Turn on “Compare to median of prior weeks” and re-run to see week-over-week movement here.</div>`;
    }
    h += `</div>`;
    return h;
  }

  // a collapsible group for the overview slide (open by default only if it's the urgent one)
  function ovGroup(title, note, list, kind, openByDefault) {
    const n = list.length;
    let h = `<details class="ov-det"${openByDefault && n ? " open" : ""}>
      <summary><span class="ov-sum-title">${escapeHtml(title)}</span> <span class="ov-count">${n}</span></summary>
      <div class="ov-note">${escapeHtml(note)}</div>`;
    if (!n) h += `<div class="empty">None.</div>`;
    else {
      const maxSev = list[0] && list[0].severity ? list[0].severity : 1;
      for (const b of list.slice(0, 12)) h += actionRow(b, kind, maxSev, true, true);
      if (n > 12) h += `<div class="empty">…and ${n - 12} more.</div>`;
    }
    h += `</details>`;
    return h;
  }

  // ---- Per-area slide: everything for one area ----
  function slideArea(strip, a, opts) {
    const area = strip.area;
    // volume-weighted day averages for this area
    const roll = a.areaRollup.find((r) => r.area === area) || { avgWait: 0, avgLoad: 0, avgCancel: 0, breachBuckets: 0, totalBuckets: 0 };
    // this area's transition tallies
    const areaBuckets = a.buckets.filter((b) => b.area === area);
    const tcount = { new: 0, worse: 0, better: 0, persisting_flat: 0, fixed: 0 };
    if (opts.compare) for (const b of areaBuckets) if (b.transition && tcount[b.transition] !== undefined) tcount[b.transition]++;

    let h = `<div class="slide-inner">
      <div class="eyebrow">${escapeHtml(opts.date)} · area</div>
      <h2 class="slide-title">${escapeHtml(area)}</h2>
      <div class="area-headline">
        <span class="ah-metric"><span class="ah-l">trips</span><span class="ah-v">${fmt.int(strip.trips)}</span></span>
        <span class="ah-metric"><span class="ah-l">avg wait</span><span class="ah-v" style="color:${rampColor(roll.avgWait,5,15)}">${fmt.wait(roll.avgWait)}</span></span>
        <span class="ah-metric"><span class="ah-l">avg load</span><span class="ah-v" style="color:${rampColor(roll.avgLoad,1,2.3)}">${fmt.load(roll.avgLoad)}</span></span>
        <span class="ah-metric"><span class="ah-l">avg cancel</span><span class="ah-v" style="color:${rampColor(roll.avgCancel,0.1,0.4)}">${fmt.pct(roll.avgCancel)}</span></span>
        <span class="ah-metric"><span class="ah-l">breaching</span><span class="ah-v">${roll.breachBuckets}/${roll.totalBuckets}</span></span>
      </div>

      <h3 class="block-title">The day</h3>
      ${stripLegend()}
      ${stripBars(strip)}

      <h3 class="block-title">Recommendation</h3>
      ${stripRecs(strip)}`;

    // Week-over-week, in-place for this area
    if (opts.compare) {
      const wd = weekdayName(opts.date);
      h += `<h3 class="block-title">Versus recent ${wd}s</h3>
        <div class="wow-inline">
          ${wowPill("newly broken", tcount.new, "alert")}
          ${wowPill("worse", tcount.worse, "alert")}
          ${wowPill("improving", tcount.better, "")}
          ${wowPill("chronic", tcount.persisting_flat, "")}
          ${wowPill("recovered", tcount.fixed, "good")}
        </div>`;
    }

    // Expandable: this area's per-30-min detail
    h += `<details class="area-detail"><summary class="details-toggle">Show 30-minute detail for ${escapeHtml(shortAreaName(area))}</summary>
      ${areaDetailTable(areaBuckets, opts.compare)}
    </details>`;

    h += `</div>`;
    return h;
  }

  function wowPill(label, n, cls) {
    return `<span class="wow-pill ${cls}"><b>${n}</b> ${escapeHtml(label)}</span>`;
  }

  // per-area 30-min table
  function areaDetailTable(buckets, compare) {
    const sorted = [...buckets].sort((a, b) => (a.hour < b.hour ? -1 : 1));
    let h = `<div class="gridwrap"><table><thead><tr>
      <th class="area">Time</th><th>Wait</th><th>Load</th><th>%Cancel</th><th>Count</th><th>Drivers</th>${compare ? "<th>vs med</th>" : ""}
    </tr></thead><tbody>`;
    for (const b of sorted) {
      const cmp = b.comparison;
      h += `<tr>
        <td class="area">${escapeHtml(b.hour)}${b.lowSample ? ' <span class="hour">(low n)</span>' : ""}</td>
        <td><span class="cell" style="background:${rampColor(b.wait,5,15)}">${fmt.wait(b.wait)}</span></td>
        <td><span class="cell" style="background:${rampColor(b.load,1,2.3)}">${fmt.load(b.load)}</span></td>
        <td><span class="cell" style="background:${rampColor(b.cancel,0.1,0.4)}">${fmt.pct(b.cancel)}</span></td>
        <td>${fmt.int(b.count)}</td>
        <td>${fmt.int(b.drivers)}</td>
        ${compare ? `<td>${cmp ? deltaSpan(cmp.dWait, true) + " wait" : "—"}</td>` : ""}
      </tr>`;
    }
    h += `</tbody></table></div>`;
    return h;
  }

  // ---- Closing slide: actions ----
  function slideActions(a, opts) {
    let h = `<div class="slide-inner">
      <div class="eyebrow">${escapeHtml(opts.date)} · what to do</div>
      <h2 class="slide-title">Actions</h2>
      <div class="section-note">Recommended incentive-block changes across all areas, in display order. Anchor = where to put or strengthen a block; reclaim = where a block can be eased.</div>`;

    h += `<div class="act-list">`;
    for (const strip of a.strips) {
      const an = strip.anchor;
      const anchorTxt = an && an.real
        ? `<span class="act-anchor">Anchor <b>${an.start}–${an.end}</b> (peak ${an.peakHour}${an.strength === "strong" ? ", strong" : ""})</span>`
        : `<span class="act-none">No block change needed</span>`;
      const reclaimTxt = strip.reclaim ? `<span class="act-reclaim">Reclaim ${strip.reclaim.start}–${strip.reclaim.end}</span>` : "";
      h += `<div class="act-row">
        <span class="act-area">${escapeHtml(strip.area)}</span>
        <span class="act-recs">${anchorTxt}${reclaimTxt}</span>
      </div>`;
    }
    h += `</div>`;

    // full audit grid still reachable here
    h += `<details class="area-detail" style="margin-top:22px"><summary class="details-toggle">Full data grid — all areas, for auditing against Metabase</summary>${fullGrid(a)}</details>`;
    h += `</div>`;
    return h;
  }

  function shortAreaName(area) { return String(area).split(" - ")[0]; }

  // strip bars only (no head/recs) — used inside the area slide
  function stripBars(strip) {
    const cells = strip.cells;
    const anchor = strip.anchor;
    let bar = `<div class="strip">`;
    for (const c of cells) {
      let bg;
      if (c.lowSample) bg = "transparent";
      else if (c.state === "over") bg = "var(--good)";
      else if (c.state === "ok") bg = "#cfd8d0";
      else bg = sevToColor(c.severity);
      const isPeak = anchor && anchor.peakHour === c.hour && anchor.real;
      bar += `<div class="strip-cell${c.lowSample ? " lowsample" : ""}" style="background:${bg}" title="${escapeHtml(c.hour)} · wait ${c.wait.toFixed(1)} · load ${c.load.toFixed(2)} · cancel ${(c.cancel*100).toFixed(0)}% · n ${c.count}">${isPeak ? '<span class="peak">◆</span>' : ""}</div>`;
    }
    bar += `</div>`;
    const ticks = `<div class="strip-ticks"><span style="flex:1;text-align:left">${cells.length ? cells[0].hour : ""}</span><span style="flex:1;text-align:right">${cells.length ? cells[cells.length-1].hour : ""}</span></div>`;
    return bar + ticks;
  }

  // recommendation rows only — used inside the area slide
  function stripRecs(strip) {
    const anchor = strip.anchor;
    let recs = `<div class="strip-recs">`;
    if (anchor) {
      if (anchor.real) {
        const tierWord = anchor.strength === "strong" ? ", strong tier" : (anchor.strength === "moderate" ? ", standard tier" : "");
        recs += `<div class="rec rec-under"><b>Anchor incentive block ${anchor.start}–${anchor.end}</b> · peak ${anchor.peakHour} — put a shift block over this window${tierWord}.</div>`;
      } else {
        recs += `<div class="rec rec-ok">No window breaching targets today. Softest stretch ${anchor.start}–${anchor.end} — no block change needed.</div>`;
      }
    }
    if (strip.reclaim) {
      recs += `<div class="rec rec-over"><b>Over-served ${strip.reclaim.start}–${strip.reclaim.end}</b> — lower tier or no incentive; reclaim for the anchor above.</div>`;
    }
    recs += `</div>`;
    return recs;
  }

  // ---- Day strip rendering ----
  function stripLegend() {
    return `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;font-size:11.5px;color:var(--ink-dim);font-family:var(--mono)">
      <span><span class="legend-sw" style="background:var(--good)"></span> healthy</span>
      <span><span class="legend-sw" style="background:#f5f5f5"></span> at target</span>
      <span><span class="legend-sw" style="background:var(--bad)"></span> under-served</span>
      <span><span class="legend-sw" style="border:1px solid var(--line);background:transparent"></span> low sample</span>
      <span>◆ peak</span>
    </div>`;
  }

  function stripBlock(strip, compare) {
    const cells = strip.cells;
    const anchor = strip.anchor;
    let bar = `<div class="strip">`;
    for (const c of cells) {
      let bg;
      if (c.lowSample) { bg = "transparent"; }
      else if (c.state === "over") bg = "var(--good)";
      else if (c.state === "ok") bg = "#cfd8d0";
      else bg = sevToColor(c.severity);
      const isPeak = anchor && anchor.peakHour === c.hour && anchor.real;
      bar += `<div class="strip-cell${c.lowSample ? " lowsample" : ""}" style="background:${bg}" title="${escapeHtml(c.hour)} · wait ${c.wait.toFixed(1)} · load ${c.load.toFixed(2)} · cancel ${(c.cancel*100).toFixed(0)}% · n ${c.count}">${isPeak ? '<span class="peak">◆</span>' : ""}</div>`;
    }
    bar += `</div>`;

    const ticks = `<div class="strip-ticks"><span style="flex:1;text-align:left">${cells.length ? cells[0].hour : ""}</span><span style="flex:1;text-align:right">${cells.length ? cells[cells.length-1].hour : ""}</span></div>`;

    let recs = `<div class="strip-recs">`;
    if (anchor) {
      if (anchor.real) {
        const tierWord = anchor.strength === "strong" ? ", strong tier" : (anchor.strength === "moderate" ? ", standard tier" : "");
        recs += `<div class="rec rec-under"><b>Anchor incentive block ${anchor.start}–${anchor.end}</b> · peak ${anchor.peakHour} — put a shift block over this window${tierWord}.</div>`;
      } else {
        // calm day: no real breach, show relative-worst stretch but say it's fine
        recs += `<div class="rec rec-ok">No window breaching targets today. Relative softest stretch is ${anchor.start}–${anchor.end} — no block change needed unless preempting.</div>`;
      }
    }
    if (strip.reclaim) {
      recs += `<div class="rec rec-over"><b>Over-served ${strip.reclaim.start}–${strip.reclaim.end}</b> — lower tier or no incentive; reclaim for the anchor above.</div>`;
    }
    recs += `</div>`;

    const lowVol = strip.trips < 150;
    return `<div class="strip-area">
      <div class="strip-head">
        <span class="strip-name">${escapeHtml(strip.area)}</span>
        <span class="strip-meta">${fmt.int(strip.trips)} trips${lowVol ? " · low volume" : ""}</span>
      </div>
      ${bar}
      ${ticks}
      ${recs}
    </div>`;
  }

  // Severity (0..~1) -> color from at-target white to deep red.
  function sevToColor(sev) {
    const t = Math.max(0, Math.min(1, sev / 0.8));
    const w = [245, 245, 245], r = [194, 53, 47];
    const c = w.map((x, i) => Math.round(x + (r[i] - x) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // A labeled sub-block of the transitions section.
  function transitionGroup(title, note, list, kind) {
    const n = list.length;
    let h = `<div style="margin:16px 0 6px;display:flex;align-items:baseline;gap:10px">
      <h3 style="font-size:14px">${escapeHtml(title)}</h3>
      <span class="hour" style="font-family:var(--mono)">${n}</span>
    </div>
    <div class="section-note" style="margin-bottom:8px">${escapeHtml(note)}</div>`;
    if (!n) { h += `<div class="empty">None.</div>`; return h; }
    const maxSev = list[0] && list[0].severity ? list[0].severity : 1;
    for (const b of list.slice(0, 20)) h += actionRow(b, kind, maxSev, true);
    if (n > 20) h += `<div class="empty">…and ${n - 20} more.</div>`;
    return h;
  }

  function actionRow(b, kind, maxSev, compare) {
    const sevPct = Math.min(100, Math.round((b.severity / (maxSev || 1)) * 100));
    const waitOver = b.wait > 12, loadOver = b.load > 1.8, cancelOver = b.cancel > 0.30;
    const cmp = b.comparison;
    const sevCol = kind === "add"
      ? `<div class="sev">sev ${b.severity.toFixed(2)}<span class="bar" style="width:${Math.max(6, sevPct * 0.5)}px"></span></div>`
      : `<div class="sev"></div>`;
    return `<div class="action-row ${kind}">
      <div class="where"><div class="hour">${escapeHtml(b.hour)}</div></div>
      <div>
        <div class="area">${escapeHtml(b.area)}${b.structuralFlag ? ' <span class="flag">wait, not load</span>' : ""}</div>
        <div class="metrics">
          <span class="metric ${waitOver ? "over" : ""}">wait <b>${fmt.wait(b.wait)}</b>${compare && cmp ? deltaSpan(cmp.dWait, true) : ""}</span>
          <span class="metric ${loadOver ? "over" : ""}">load <b>${fmt.load(b.load)}</b>${compare && cmp ? deltaSpan(cmp.dLoad, true) : ""}</span>
          <span class="metric ${cancelOver ? "over" : ""}">cancel <b>${fmt.pct(b.cancel)}</b>${compare && cmp ? deltaSpan(cmp.dCancel * 100, true) : ""}</span>
          <span class="metric">n <b>${fmt.int(b.count)}</b></span>
        </div>
      </div>
      ${sevCol}
    </div>`;
  }

  function fullGrid(a) {
    // pivot: rows = hour, columns grouped by area, metrics wait/load/cancel
    const hours = [...new Set(a.buckets.map((b) => b.hour))].sort();
    const areas = [...new Set(a.buckets.map((b) => b.area))];
    const key = {}; a.buckets.forEach((b) => { key[b.area + "|" + b.hour] = b; });
    let h = `<div class="gridwrap"><table><thead><tr><th class="area">Hour</th>`;
    for (const ar of areas) h += `<th colspan="3">${escapeHtml(ar)}</th>`;
    h += `</tr><tr><th class="area"></th>`;
    for (let i = 0; i < areas.length; i++) h += `<th>wait</th><th>load</th><th>%c</th>`;
    h += `</tr></thead><tbody>`;
    for (const hr of hours) {
      h += `<tr><td class="area">${escapeHtml(hr)}</td>`;
      for (const ar of areas) {
        const b = key[ar + "|" + hr];
        if (!b) { h += `<td></td><td></td><td></td>`; continue; }
        h += `<td><span class="cell" style="background:${rampColor(b.wait, 5, 15)}">${fmt.wait(b.wait)}</span></td>
              <td><span class="cell" style="background:${rampColor(b.load, 1, 2.3)}">${fmt.load(b.load)}</span></td>
              <td><span class="cell" style="background:${rampColor(b.cancel, 0.1, 0.4)}">${fmt.pct(b.cancel)}</span></td>`;
      }
      h += `</tr>`;
    }
    h += `</tbody></table></div>`;
    return h;
  }

  function weekdayName(dateStr) {
    return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(dateStr + "T00:00:00").getDay()];
  }

  // ---- wire up ----
  $("loginBtn").addEventListener("click", doLogin);
  $("p").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("u").addEventListener("keydown", (e) => { if (e.key === "Enter") $("p").focus(); });
  $("logoutBtn").addEventListener("click", doLogout);
  $("runBtn").addEventListener("click", run);

  // restore session if present
  if (getToken()) showApp(); else showLogin();
})();
