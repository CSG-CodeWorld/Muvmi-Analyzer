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
  let deckKeyHandler = null; // current deck keyboard listener, so renders don't stack them

  // Toggle which metric chart shows for an area (called from inline onclick in the deck).
  window.__chartTab = function (areaId, metric) {
    document.querySelectorAll(`.chart-pane[data-chart="${areaId}"]`).forEach((p) => {
      p.style.display = p.dataset.metric === metric ? "" : "none";
    });
    document.querySelectorAll(`.chart-tab[data-chart="${areaId}"]`).forEach((t) => {
      t.classList.toggle("active", t.dataset.metric === metric);
    });
  };

  // Chart point tooltip — one shared element, delegated hover on any [data-tip] target.
  (function setupChartTip() {
    let tip = null;
    const ensure = () => {
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "chart-tip";
        tip.style.display = "none";
        document.body.appendChild(tip);
      }
      return tip;
    };
    document.addEventListener("mouseover", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) return;
      const el = ensure();
      el.textContent = t.getAttribute("data-tip");
      el.style.borderLeftColor = t.getAttribute("data-over") === "1" ? "#d6391f" : "var(--good)";
      el.style.display = "block";
    });
    document.addEventListener("mousemove", (e) => {
      if (!tip || tip.style.display === "none") return;
      const pad = 14;
      let left = e.clientX + pad, top = e.clientY + pad;
      const r = tip.getBoundingClientRect();
      if (left + r.width > window.innerWidth - 8) left = e.clientX - r.width - pad;
      if (top + r.height > window.innerHeight - 8) top = e.clientY - r.height - pad;
      tip.style.left = left + "px"; tip.style.top = top + "px";
    });
    document.addEventListener("mouseout", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (t && tip) tip.style.display = "none";
    });
  })();

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
      // Parse defensively: a server timeout returns a non-JSON error page, which would
      // otherwise throw a cryptic "Unexpected token". Read text first.
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); }
      catch {
        if (r.status === 504 || /timed out|timeout/i.test(text)) {
          throw new Error("Login timed out. Metabase may be throttling after repeated attempts — wait a minute and try again.");
        }
        throw new Error(`Login got an unexpected response (status ${r.status}). Wait a moment and retry.`);
      }
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
  // Pull one date. Returns {cols, rows} or throws a readable error.
  async function pullDate(date) {
    const r = await fetch("/api/pull", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken(), date }),
    });
    // The function may return a non-JSON error page (e.g. on a server timeout). Read as
    // text first and parse defensively, so we never throw a cryptic "Unexpected token".
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch {
      if (r.status === 504 || /timeout/i.test(text)) throw new Error("The query timed out on the server. Try again, or use fewer comparison weeks.");
      throw new Error(`The server returned an unexpected response (status ${r.status}). Try again in a moment.`);
    }
    if (j.error) {
      if (/log in again|Session expired|Not logged in/i.test(j.error)) { clearSession(); showLogin(); }
      throw new Error(j.error);
    }
    // Empty result = no data for that date yet (common before the daily upload lands).
    if (!j.rows || j.rows.length === 0) {
      throw new Error(`No data for ${date} yet — it may not be uploaded to Metabase yet. Try an earlier date.`);
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
        if (i === 0) {
          // The analysis date itself — a miss here is fatal (nothing to analyze).
          pulls[d] = await pullDate(d);
        } else {
          // A prior comparison week — if it has no data, skip it rather than abort,
          // and the median just uses the weeks that do have data.
          try { pulls[d] = await pullDate(d); }
          catch (e) { /* skip this week */ }
        }
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

    $("report").innerHTML = `<div class="deck">${nav}${track}</div>`;
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
    // keyboard arrows — remove any handler from a previous render so they don't stack
    // (render() runs again on every analysis; document-level listeners would accumulate).
    if (deckKeyHandler) document.removeEventListener("keydown", deckKeyHandler);
    deckKeyHandler = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.key === "ArrowRight") go(cur + 1);
      else if (e.key === "ArrowLeft") go(cur - 1);
    };
    document.addEventListener("keydown", deckKeyHandler);
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
      <div class="benchmarks">
        <span class="bm-label">Benchmarks</span>
        <span class="bm"><b>Load</b> ≤ ${a.targets.load}</span>
        <span class="bm"><b>%Cancel</b> ≤ ${Math.round(a.targets.cancel * 100)}%</span>
        <span class="bm"><b>Wait</b> ≤ ${a.targets.wait} min</span>
        <span class="bm-note">a slot is “understaffed” if it breaches any of these</span>
      </div>
      <div class="tiles">
        <div class="tile"><div class="n">${fmt.int(s.totalTrips)}</div><div class="l">trips today</div></div>
        <div class="tile"><div class="n">${s.areas}</div><div class="l">areas</div></div>
        <div class="tile ${s.addCount ? "alert" : "good"}"><div class="n">${s.addCount}</div><div class="l">understaffed slots</div></div>
        <div class="tile good"><div class="n">${s.pullCount}</div><div class="l">over-served slots</div></div>
      </div>`;

    if (opts.compare && a.transitionSummary) {
      const ts = a.transitionSummary;
      h += `<h3 class="block-title">Versus recent ${wd}s — across all areas</h3>
        <div class="section-note">How today's slots compare to the median of the prior ${opts.weeks} ${wd}s. Tap an area below or its tab to see its slots.</div>
        <div class="tiles wow">
          <div class="tile alert"><div class="n">${ts.deficit}</div><div class="l">critical slots</div></div>
          <div class="tile alert"><div class="n">${ts.newlyUnderstaffed}</div><div class="l">newly understaffed</div></div>
          <div class="tile alert"><div class="n">${ts.worsening}</div><div class="l">getting worse</div></div>
          <div class="tile"><div class="n">${ts.improving}</div><div class="l">improving</div></div>
          <div class="tile"><div class="n">${ts.persistent}</div><div class="l">persistent issue</div></div>
          <div class="tile good"><div class="n">${ts.recovered}</div><div class="l">recovered</div></div>
          <div class="tile good"><div class="n">${ts.surplus}</div><div class="l">surplus (reclaim)</div></div>
        </div>`;

      // Per-area scoreboard: which areas the counts come from. Name + a row of numbers.
      h += `<h3 class="block-title">By area — where it's coming from</h3>
        ${scoreboard(a, opts)}`;
    } else {
      h += `<div class="section-note" style="margin-top:18px">Turn on “Compare to median of prior weeks” and re-run to see week-over-week movement here.</div>`;
    }
    h += `</div>`;
    return h;
  }

  // Compact per-area tally of the transition categories. Glanceable: name + counts.
  function scoreboard(a, opts) {
    const tally = {};
    for (const strip of a.strips) tally[strip.area] = { area: strip.area, priority: 0, newU: 0, worse: 0, improving: 0, persistent: 0, recovered: 0, surplus: 0 };
    for (const b of a.buckets) {
      const t = tally[b.area]; if (!t) continue;
      if (b.transition === "new") t.newU++;
      else if (b.transition === "worse") t.worse++;
      else if (b.transition === "better") t.improving++;
      else if (b.transition === "persisting_flat") t.persistent++;
      else if (b.transition === "fixed") t.recovered++;
      if (b.isSurplus) t.surplus++;
      if (b.isDeficit) t.priority++;
    }
    // Critical (deficit) leads — it's the "where are the worst understaffed slots"
    // signal, the inverse of surplus. Then the movement columns, then surplus.
    let h = `<div class="gridwrap"><table class="scoreboard"><thead><tr>
      <th class="area">Area</th>
      <th title="Count of this area's 30-min slots that rank among the most severely understaffed citywide. Higher = more of the worst slots = more urgent. (A count, not a rank.)">Critical</th>
      <th title="Slots fine on recent weeks but understaffed today">Newly u.staffed</th>
      <th title="Already understaffed, worse than recent median">Worse</th>
      <th title="Still understaffed but better than recent median">Improving</th>
      <th title="Understaffed on recent weeks and still today, roughly flat">Persistent</th>
      <th title="Was understaffed on recent weeks, fine today">Recovered</th>
      <th title="Most over-served slots citywide that fall in this area — reclaim candidates">Surplus</th>
    </tr></thead><tbody>`;
    for (const strip of a.strips) {
      const t = tally[strip.area];
      const cell = (n, cls) => `<td>${n ? `<span class="sb-n ${cls}">${n}</span>` : '<span class="sb-z">·</span>'}</td>`;
      h += `<tr>
        <td class="area">${escapeHtml(strip.area)}</td>
        ${cell(t.priority, "bad")}${cell(t.newU, "bad")}${cell(t.worse, "bad")}${cell(t.improving, "")}${cell(t.persistent, "warn")}${cell(t.recovered, "good")}${cell(t.surplus, "good")}
      </tr>`;
    }
    h += `</tbody></table></div>`;
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
      ${dayChartBlock(strip, areaBuckets, opts)}

      <h3 class="block-title">The three together</h3>
      ${relationalBlock(areaBuckets, opts)}

      <h3 class="block-title">Recommendation</h3>
      ${stripRecs(strip)}`;

    // Week-over-week, in-place for this area
    if (opts.compare) {
      const wd = weekdayName(opts.date);
      const surplusN = areaBuckets.filter((b) => b.isSurplus).length;
      h += `<h3 class="block-title">Versus recent ${wd}s</h3>
        <div class="wow-inline">
          ${wowPill("newly understaffed", tcount.new, "alert")}
          ${wowPill("getting worse", tcount.worse, "alert")}
          ${wowPill("improving", tcount.better, "")}
          ${wowPill("persistent issue", tcount.persisting_flat, "warn")}
          ${wowPill("recovered", tcount.fixed, "good")}
          ${wowPill("surplus", surplusN, "good")}
        </div>`;
    }

    // Expandable: this area's 30-min blocks, grouped by type (within this area).
    h += `<details class="area-detail"><summary class="details-toggle">Show 30-minute blocks for ${escapeHtml(shortAreaName(area))}, by type</summary>
      <div style="margin-top:12px">${areaTypeGroups(areaBuckets, opts.compare)}</div>
    </details>`;

    h += `</div>`;
    return h;
  }

  function wowPill(label, n, cls) {
    return `<span class="wow-pill ${cls}"><b>${n}</b> ${escapeHtml(label)}</span>`;
  }

  // This area's 30-min blocks, separated by type then listed. Keeps the type sort but
  // scopes it to one area (area sort on top of type sort).
  function areaTypeGroups(buckets, compare) {
    const understaffed = buckets.filter((b) => !b.lowSample && b.breaches.length > 0).sort((a, b) => b.severity - a.severity);
    const surplus = buckets.filter((b) => b.isSurplus).sort((a, b) => (b.slack || 0) - (a.slack || 0));
    const lowSample = buckets.filter((b) => b.lowSample && b.breaches.length > 0);
    const fine = buckets.filter((b) => !b.lowSample && b.breaches.length === 0 && !b.isSurplus);

    let h = "";
    h += typeBlock("Understaffed — breaching a target", understaffed, "under", compare);
    h += typeBlock("Surplus — most slack, reclaim candidates", surplus, "over", compare);
    if (lowSample.length) h += typeBlock("Low sample — too few trips to act on", lowSample, "watch", compare);
    // healthy/at-benchmark shown compactly as a count, expandable
    if (fine.length) {
      h += `<details class="type-fine"><summary>At benchmark — ${fine.length} slot${fine.length>1?"s":""} healthy</summary>
        ${miniBlockTable(fine.sort((a,b)=>(a.hour<b.hour?-1:1)), compare)}</details>`;
    }
    return h;
  }

  function typeBlock(title, list, tone, compare) {
    let h = `<div class="type-group">
      <div class="type-head type-${tone}">${escapeHtml(title)} <span class="type-n">${list.length}</span></div>`;
    if (!list.length) h += `<div class="empty">None.</div>`;
    else h += miniBlockTable(list, compare);
    h += `</div>`;
    return h;
  }

  // compact table of 30-min blocks: each stat shows its value + delta vs prior-week
  // median inline (no data dropped), plus distinct drivers and a severity column.
  function miniBlockTable(list, compare) {
    let h = `<div class="gridwrap"><table><thead><tr>
      <th class="area">Time</th><th>Wait</th><th>Load</th><th>%Cancel</th><th>Count</th><th>Drivers</th><th>Severity</th>
    </tr></thead><tbody>`;
    for (const b of list) {
      const cmp = b.comparison;
      const sevVal = b.severity > 0 ? `+${b.severity.toFixed(2)}` : (b.slack > 0 ? `−${b.slack.toFixed(2)}` : "0");
      const sevCls = b.severity > 0 ? "sev-over" : (b.slack > 0 ? "sev-under" : "");
      // count delta is volume, not good/bad — render it neutral.
      const countDelta = (compare && cmp) ? `<span class="delta neutral">${cmp.dCount > 0 ? "▲" : cmp.dCount < 0 ? "▼" : ""}${cmp.dCount ? Math.abs(Math.round(cmp.dCount)) : ""}</span>` : "";
      h += `<tr>
        <td class="area">${escapeHtml(b.hour)}</td>
        <td><span class="cell" style="background:${rampColor(b.wait,5,15)}">${fmt.wait(b.wait)}</span>${compare && cmp ? deltaSpan(cmp.dWait, true) : ""}</td>
        <td><span class="cell" style="background:${rampColor(b.load,1,2.3)}">${fmt.load(b.load)}</span>${compare && cmp ? deltaSpan(cmp.dLoad, true) : ""}</td>
        <td><span class="cell" style="background:${rampColor(b.cancel,0.1,0.4)}">${fmt.pct(b.cancel)}</span>${compare && cmp ? deltaSpan(cmp.dCancel * 100, true) : ""}</td>
        <td>${fmt.int(b.count)}${countDelta}</td>
        <td>${fmt.int(b.drivers)}</td>
        <td><span class="sev-tag ${sevCls}">${sevVal}</span></td>
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

  // ---- Day chart: paints severity. Replaces the old colored strip on area slides. ----
  // Three metrics (wait/load/cancel) toggled by tabs. Each chart fills the gap above the
  // benchmark in red, depth = how far over, so the worst stretches read boldest. A faint
  // dashed line shows a normal recent day (prior-weeks median). No reading required to
  // see where and how bad the trouble is.
  const CHART_METRICS = {
    wait:   { label: "Wait time", pct: false, target: () => Analysis.TARGETS.wait,   domain: [0, 26], key: "wait",   med: "medWait" },
    load:   { label: "Load",      pct: false, target: () => Analysis.TARGETS.load,   domain: [0, 3],  key: "load",   med: "medLoad" },
    cancel: { label: "Cancellations", pct: true, target: () => Analysis.TARGETS.cancel, domain: [0, 0.6], key: "cancel", med: "medCancel" },
  };

  // Volume metrics have NO benchmark (more rides / more drivers is neither good nor
  // bad on its own), so they render as plain today-vs-normal curves, not severity paint.
  const VOLUME_METRICS = {
    rides:   { label: "Rides",   key: "count",   med: "medCount",   ctxKey: "drivers", ctxLabel: "drivers" },
    drivers: { label: "Drivers", key: "drivers", med: "medDrivers", ctxKey: "count",   ctxLabel: "trips" },
  };

  // The three benchmarked metrics, normalized to "× of benchmark" for the relational chart.
  const REL_METRICS = [
    { key: "wait",   label: "Wait",   color: "#4a9eff", target: () => Analysis.TARGETS.wait },
    { key: "load",   label: "Load",   color: "#d9a441", target: () => Analysis.TARGETS.load },
    { key: "cancel", label: "Cancel", color: "#e06ec9", target: () => Analysis.TARGETS.cancel },
  ];

  // Shared "nice bounds" axis math (used by the volume + relational charts). The
  // severity chart keeps its own inline copy so its tuned behavior stays untouched.
  function niceAxis(vals, floorZero) {
    let dataMax = Math.max(...vals);
    let dataMin = floorZero ? 0 : Math.min(...vals);
    if (!isFinite(dataMax)) dataMax = 1;
    if (!isFinite(dataMin)) dataMin = 0;
    const range0 = dataMax - dataMin;
    let hi = dataMax + range0 * 0.12;
    let lo = floorZero ? 0 : Math.max(0, dataMin - range0 * 0.05);
    const niceStep = (range) => {
      const raw = range / 3, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
      const norm = raw / mag;
      const step = norm >= 5 ? 5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5;
      return step * mag;
    };
    const step = niceStep(hi - lo) || 1;
    hi = Math.ceil(hi / step) * step;
    lo = floorZero ? 0 : Math.floor(lo / step) * step;
    if (hi <= lo) hi = lo + step;
    return { lo, hi, step };
  }

  function dayChartBlock(strip, areaBuckets, opts) {
    const sorted = [...areaBuckets].sort((a, b) => (a.hour < b.hour ? -1 : 1));
    const areaId = "ch_" + Math.abs(hashStr(strip.area));
    const order = ["wait", "load", "cancel", "rides", "drivers"];
    const labelOf = (k) => (CHART_METRICS[k] ? CHART_METRICS[k].label : VOLUME_METRICS[k].label);
    // overall status from understaffed-bucket count (wait drives, but any breach counts)
    const breachN = sorted.filter((b) => !b.lowSample && b.breaches.length > 0).length;
    const status = breachN === 0 ? { t: "Healthy", c: "var(--good)" }
                 : breachN <= 4 ? { t: "Minor strain", c: "var(--warn)" }
                 : { t: "Understaffed", c: "var(--bad)" };

    let tabs = "";
    order.forEach((k, i) => {
      tabs += `<button class="chart-tab${i === 0 ? " active" : ""}" data-chart="${areaId}" data-metric="${k}" onclick="window.__chartTab('${areaId}','${k}')">${labelOf(k)}</button>`;
    });
    let charts = "";
    order.forEach((k, i) => {
      const body = CHART_METRICS[k]
        ? severityChart(sorted, CHART_METRICS[k], opts.compare)
        : volumeChart(sorted, VOLUME_METRICS[k], opts.compare);
      charts += `<div class="chart-pane" data-chart="${areaId}" data-metric="${k}" style="${i === 0 ? "" : "display:none"}">${body}</div>`;
    });

    return `<div class="day-chart">
      <div class="chart-bar">
        <span class="chart-status" style="color:${status.c}">${status.t}</span>
        <div class="chart-tabs">${tabs}</div>
      </div>
      ${charts}
      <div class="chart-legend">
        <span><span class="lg-line today"></span> today</span>
        <span><span class="lg-line normal"></span> normal day</span>
        <span><span class="lg-fill"></span> over benchmark (wait / load / cancel tabs)</span>
      </div>
    </div>`;
  }

  function severityChart(sorted, def, compare) {
    const W = 560, H = 280, padL = 46, padR = 16, padT = 18, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = sorted.length || 1;
    const target = def.target();
    const today = sorted.map((b) => b[def.key]);
    const med = sorted.map((b) => (compare && b.comparison ? b.comparison[def.med] : null));

    // Dynamic y-axis: fit the actual data instead of a fixed cap (which clipped high
    // outliers and flattened calm days). Always keep the benchmark on-scale so "are we
    // near the line" stays readable, and keep a little headroom above the peak.
    const vals = today.concat(med.filter((v) => v != null));
    let dataMax = Math.max(target, ...vals);
    let dataMin = Math.min(target, ...vals, 0); // include 0 so the floor stays grounded
    // headroom above the highest point, and a touch below the lowest
    let hi = dataMax + (dataMax - dataMin) * 0.12;
    let lo = Math.max(0, dataMin - (dataMax - dataMin) * 0.05);
    // round to "nice" bounds for clean axis labels
    const niceStep = (range) => {
      const raw = range / 3, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
      const norm = raw / mag;
      const step = norm >= 5 ? 5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5;
      return step * mag;
    };
    const step = niceStep(hi - lo) || 1;
    hi = Math.ceil(hi / step) * step;
    lo = def.pct ? 0 : Math.floor(lo / step) * step; // cancel always floors at 0
    if (hi <= lo) hi = lo + step;
    const d0 = lo, d1 = hi;

    const x = (i) => padL + (i / (n - 1)) * iw;
    const clamp = (v) => Math.min(Math.max(v, d0), d1);
    const y = (v) => padT + ih - ((clamp(v) - d0) / (d1 - d0)) * ih;
    const tgtY = y(target);
    const fmt = (v) => def.pct ? Math.round(v * 100) + "%" : (Number.isInteger(v) ? v : (Math.round(v * 10) / 10));
    const lineOf = (arr) => {
      let started = false, d = "";
      arr.forEach((v, i) => { if (v == null) return; d += (started ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); started = true; });
      return d;
    };

    // worst over-amount for scaling fill opacity
    const worst = Math.max(0.001, ...today.map((v) => (v - target) / (d1 - target)));
    // red fill segments where today is above target
    let segs = "";
    for (let i = 0; i < n - 1; i++) {
      const a = today[i], b = today[i + 1];
      if (a > target || b > target) {
        const xa = x(i), xb = x(i + 1);
        let xs = xa, xe = xb, ya = a, yb = b;
        if (a <= target) { const f = (target - a) / (b - a); xs = xa + (xb - xa) * f; ya = target; }
        if (b <= target) { const f = (target - a) / (b - a); xe = xa + (xb - xa) * f; yb = target; }
        const over = (Math.max(a, b) - target) / (d1 - target);
        const op = (0.3 + 0.6 * Math.min(over / worst, 1)).toFixed(2);
        segs += `<path d="M${xs.toFixed(1)},${tgtY} L${xs.toFixed(1)},${y(ya).toFixed(1)} L${xe.toFixed(1)},${y(yb).toFixed(1)} L${xe.toFixed(1)},${tgtY} Z" fill="#d6391f" fill-opacity="${op}"/>`;
      }
    }
    // faint green floor where healthy
    const belowPts = today.map((v, i) => "L" + x(i).toFixed(1) + "," + Math.max(y(v), tgtY).toFixed(1)).join(" ");
    const belowFill = `<path d="M${x(0)},${tgtY} ${belowPts} L${x(n - 1)},${tgtY} Z" fill="#2f9e44" fill-opacity="0.06"/>`;

    let xt = "";
    for (let i = 0; i < n; i += 4) xt += `<text x="${x(i)}" y="${H - 8}" fill="var(--ink-faint)" font-size="10" text-anchor="middle">${escapeHtml(sorted[i].hour)}</text>`;
    let yt = "";
    [d0, target, d1].forEach((tk) => { yt += `<text x="${padL - 8}" y="${y(tk) + 3}" fill="var(--ink-faint)" font-size="10" text-anchor="end">${fmt(tk)}</text>`; });

    // peak callout
    let peak = "";
    const pv = Math.max(...today), pi = today.indexOf(pv);
    if (pv > target) {
      peak = `<circle cx="${x(pi).toFixed(1)}" cy="${y(pv).toFixed(1)}" r="4" fill="#d6391f"/>
        <text x="${x(pi).toFixed(1)}" y="${(y(pv) - 9).toFixed(1)}" fill="#c0392b" font-size="11" font-weight="500" text-anchor="middle">${fmt(pv)}</text>`;
    }

    // plotted points on today's line + invisible wide hover targets carrying the slot's
    // real numbers, so each 30-min point can be inspected on hover.
    let pts = "", hits = "";
    sorted.forEach((b, i) => {
      const over = today[i] > target;
      const cx = x(i).toFixed(1), cy = y(today[i]).toFixed(1);
      pts += `<circle cx="${cx}" cy="${cy}" r="${i === pi && pv > target ? 0 : 2.3}" fill="${over ? "#d6391f" : "var(--ink)"}" stroke="var(--panel)" stroke-width="0.5"/>`;
      const medTxt = (compare && b.comparison) ? fmt(b.comparison[def.med]) : "—";
      const tip = `${b.hour}\u2002·\u2002${def.label}: ${fmt(today[i])}\u2002·\u2002benchmark ${fmt(target)}\u2002·\u2002normal ${medTxt}\u2002·\u2002${b.count} trips, ${b.drivers} drivers`;
      hits += `<circle cx="${cx}" cy="${cy}" r="12" fill="transparent" style="cursor:pointer" data-tip="${escapeHtml(tip)}" data-over="${over ? 1 : 0}"/>`;
    });

    return `<svg viewBox="0 0 ${W} ${H}" style="display:block;width:100%;height:auto" role="img" aria-label="${escapeHtml(def.label)} across the day versus benchmark">
      ${belowFill}${segs}
      <line x1="${padL}" y1="${tgtY}" x2="${W - padR}" y2="${tgtY}" stroke="#c0392b" stroke-width="1.4" stroke-dasharray="2 3"/>
      <text x="${W - padR}" y="${tgtY - 5}" fill="#c0392b" font-size="10" text-anchor="end">benchmark ${fmt(target)}</text>
      ${compare ? `<path d="${lineOf(med)}" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-dasharray="4 4"/>` : ""}
      <path d="${lineOf(today)}" fill="none" stroke="var(--ink)" stroke-width="2.6" stroke-linejoin="round"/>
      ${peak}${pts}${yt}${xt}${hits}
    </svg>`;
  }

  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

  // ---- Volume chart: plain today-vs-normal curve for rides / drivers. ----
  // No benchmark (volume isn't good or bad on its own). A subtle tint fills the gap
  // between today and the normal-day median so you can see at a glance whether the
  // day ran above (blue) or below (grey) typical, without reading the numbers.
  function volumeChart(sorted, def, compare) {
    const W = 560, H = 280, padL = 46, padR = 16, padT = 18, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = sorted.length || 1;
    const today = sorted.map((b) => b[def.key]);
    const med = sorted.map((b) => (compare && b.comparison ? b.comparison[def.med] : null));
    const vals = today.concat(med.filter((v) => v != null));
    const { lo, hi } = niceAxis(vals.length ? vals : [0, 1], true);
    const d0 = lo, d1 = hi || 1;
    const x = (i) => padL + (i / (n - 1)) * iw;
    const y = (v) => padT + ih - ((Math.min(Math.max(v, d0), d1) - d0) / (d1 - d0)) * ih;
    const lineOf = (arr) => { let s = false, d = ""; arr.forEach((v, i) => { if (v == null) return; d += (s ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); s = true; }); return d; };

    // deviation fill between today and normal, tinted by direction
    let dev = "";
    if (compare) {
      for (let i = 0; i < n - 1; i++) {
        const a0 = today[i], a1 = today[i + 1], m0 = med[i], m1 = med[i + 1];
        if (m0 == null || m1 == null) continue;
        const above = (a0 + a1) / 2 >= (m0 + m1) / 2;
        const col = above ? "#4a9eff" : "#5c6772";
        dev += `<path d="M${x(i).toFixed(1)},${y(a0).toFixed(1)} L${x(i + 1).toFixed(1)},${y(a1).toFixed(1)} L${x(i + 1).toFixed(1)},${y(m1).toFixed(1)} L${x(i).toFixed(1)},${y(m0).toFixed(1)} Z" fill="${col}" fill-opacity="0.10"/>`;
      }
    }

    const fmtV = (v) => Math.round(v).toLocaleString();
    let yt = "";
    [d0, (d0 + d1) / 2, d1].forEach((tk) => { yt += `<text x="${padL - 8}" y="${y(tk) + 3}" fill="var(--ink-faint)" font-size="10" text-anchor="end">${fmtV(tk)}</text>`; });
    let xt = "";
    for (let i = 0; i < n; i += 4) xt += `<text x="${x(i)}" y="${H - 8}" fill="var(--ink-faint)" font-size="10" text-anchor="middle">${escapeHtml(sorted[i].hour)}</text>`;

    let pts = "", hits = "";
    sorted.forEach((b, i) => {
      const cx = x(i).toFixed(1), cy = y(today[i]).toFixed(1);
      pts += `<circle cx="${cx}" cy="${cy}" r="2.3" fill="var(--ink)" stroke="var(--panel)" stroke-width="0.5"/>`;
      const medTxt = (compare && b.comparison && b.comparison[def.med] != null) ? fmtV(b.comparison[def.med]) : "—";
      const ctxVal = b[def.ctxKey];
      const tip = `${b.hour}\u2002·\u2002${def.label}: ${fmtV(today[i])}\u2002·\u2002normal ${medTxt}\u2002·\u2002${fmtV(ctxVal)} ${def.ctxLabel}`;
      hits += `<circle cx="${cx}" cy="${cy}" r="12" fill="transparent" style="cursor:pointer" data-tip="${escapeHtml(tip)}" data-over="0"/>`;
    });

    return `<svg viewBox="0 0 ${W} ${H}" style="display:block;width:100%;height:auto" role="img" aria-label="${escapeHtml(def.label)} across the day">
      ${dev}
      ${compare ? `<path d="${lineOf(med)}" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-dasharray="4 4"/>` : ""}
      <path d="${lineOf(today)}" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linejoin="round"/>
      ${pts}${yt}${xt}${hits}
    </svg>`;
  }

  // ---- Relational chart: all three benchmarked metrics on ONE shared scale. ----
  // Each metric is divided by its own target, so wait (min), load (ratio) and cancel
  // (%) collapse onto a single "× of benchmark" axis. 1.0× is the shared benchmark
  // line; above it = breaching. Three lines instead of three charts, honestly
  // comparable, with a faint trip-volume silhouette behind for context. This is the
  // "everything together, without overloading" view.
  function relationalChart(sorted) {
    const W = 560, H = 300, padL = 40, padR = 16, padT = 18, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = sorted.length || 1;
    const ratios = REL_METRICS.map((m) => { const t = m.target() || 1; return sorted.map((b) => b[m.key] / t); });
    const allR = ratios.flat().filter((v) => isFinite(v));
    let hi = Math.max(1.2, ...allR) * 1.12;
    hi = Math.ceil(hi / 0.5) * 0.5;
    const d0 = 0, d1 = hi;
    const x = (i) => padL + (i / (n - 1)) * iw;
    const y = (v) => padT + ih - ((Math.min(Math.max(v, d0), d1) - d0) / (d1 - d0)) * ih;
    const oneY = y(1);

    // faint trip-volume backdrop, scaled to its own range (shape only, no axis)
    const cMax = Math.max(1, ...sorted.map((b) => b.count));
    const vy = (c) => padT + ih - (c / cMax) * ih * 0.9;
    let vol = `M${x(0).toFixed(1)},${(padT + ih).toFixed(1)}`;
    sorted.forEach((b, i) => { vol += `L${x(i).toFixed(1)},${vy(b.count).toFixed(1)}`; });
    vol += `L${x(n - 1).toFixed(1)},${(padT + ih).toFixed(1)} Z`;
    const volPath = `<path d="${vol}" fill="var(--ink-faint)" fill-opacity="0.10" stroke="none"/>`;

    // faint wash over the whole above-benchmark region
    const wash = `<rect x="${padL}" y="${padT}" width="${iw}" height="${(oneY - padT).toFixed(1)}" fill="#d6391f" fill-opacity="0.05"/>`;

    const lineOf = (arr) => { let s = false, d = ""; arr.forEach((v, i) => { if (v == null || !isFinite(v)) return; d += (s ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); s = true; }); return d; };
    let lines = "", dots = "", hits = "";
    REL_METRICS.forEach((m, mi) => {
      lines += `<path d="${lineOf(ratios[mi])}" fill="none" stroke="${m.color}" stroke-width="2.2" stroke-linejoin="round" opacity="0.95"/>`;
      const t = m.target();
      sorted.forEach((b, i) => {
        const cx = x(i).toFixed(1), cy = y(ratios[mi][i]).toFixed(1);
        dots += `<circle cx="${cx}" cy="${cy}" r="1.6" fill="${m.color}"/>`;
        const raw = m.key === "cancel" ? Math.round(b[m.key] * 100) + "%" : (m.key === "load" ? b[m.key].toFixed(2) : b[m.key].toFixed(1));
        const bm = m.key === "cancel" ? Math.round(t * 100) + "%" : (m.key === "load" ? t.toFixed(2) : t.toFixed(1));
        const tip = `${b.hour}\u2002·\u2002${m.label} ${raw}\u2002·\u2002${ratios[mi][i].toFixed(2)}× of benchmark ${bm}`;
        hits += `<circle cx="${cx}" cy="${cy}" r="9" fill="transparent" style="cursor:pointer" data-tip="${escapeHtml(tip)}" data-over="${b[m.key] > t ? 1 : 0}"/>`;
      });
    });

    let yt = "";
    [0, 1, d1].forEach((tk) => { if (tk > d1) return; yt += `<text x="${padL - 7}" y="${y(tk) + 3}" fill="var(--ink-faint)" font-size="10" text-anchor="end">${tk}×</text>`; });
    let xt = "";
    for (let i = 0; i < n; i += 4) xt += `<text x="${x(i)}" y="${H - 8}" fill="var(--ink-faint)" font-size="10" text-anchor="middle">${escapeHtml(sorted[i].hour)}</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" style="display:block;width:100%;height:auto" role="img" aria-label="Wait, load and cancellations as multiples of their benchmark across the day">
      ${volPath}${wash}
      <line x1="${padL}" y1="${oneY}" x2="${W - padR}" y2="${oneY}" stroke="#c0392b" stroke-width="1.3" stroke-dasharray="3 3"/>
      <text x="${W - padR}" y="${(oneY - 5).toFixed(1)}" fill="#c0392b" font-size="10" text-anchor="end">benchmark · 1.0×</text>
      ${lines}${dots}${yt}${xt}${hits}
    </svg>`;
  }

  // The relational chart + the auto-generated plain-language read directly beneath it.
  function relationalBlock(areaBuckets, opts) {
    const sorted = [...areaBuckets].sort((a, b) => (a.hour < b.hour ? -1 : 1));
    const read = (Analysis.interpretArea) ? Analysis.interpretArea(areaBuckets) : null;
    const toneCls = read ? ({ good: "read-good", bad: "read-bad", warn: "read-warn", flat: "read-flat" }[read.tone] || "read-warn") : "";
    const note = `<div class="section-note" style="margin:0 0 8px">Each line is that metric divided by its own target, so all three share one scale — above the dashed line is over benchmark. Three rising together usually means a real shortage; one breaking alone usually means something else (the read below sorts out which).</div>`;
    const legend = `<div class="rel-legend">
      <span><span class="rel-sw" style="background:#4a9eff"></span> wait</span>
      <span><span class="rel-sw" style="background:#d9a441"></span> load</span>
      <span><span class="rel-sw" style="background:#e06ec9"></span> cancel</span>
      <span><span class="rel-sw bm"></span> 1.0× benchmark</span>
      <span><span class="rel-sw vol"></span> trip volume (context)</span>
    </div>`;
    const readBlock = read
      ? `<div class="read ${toneCls}"><div class="read-h">${escapeHtml(read.headline)}</div><div class="read-d">${escapeHtml(read.detail)}</div></div>`
      : "";
    return `<div class="day-chart">
      ${note}
      ${relationalChart(sorted)}
      ${legend}
    </div>
    ${readBlock}`;
  }

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
  // ---- Help / glossary modal ----
  function openHelp() {
    const existing = document.getElementById("helpOverlay");
    if (existing) { existing.remove(); return; }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "helpOverlay";
    overlay.innerHTML = `<div class="modal" role="dialog" aria-label="Help">
      <button class="modal-close" id="helpClose">Close</button>
      <h2>How to read this</h2>
      <div class="modal-sub">A quick guide to the labels and what each number is compared against.</div>

      <h3>Reading the charts</h3>
      <dl>
        <dt>Wait / Load / Cancellations tabs</dt><dd>One metric across the day. Today is the solid line; the faint dashed line is a normal day (median of recent same-weekdays). Wherever today goes over its benchmark, the gap is filled red — deeper red means further over.</dd>
        <dt>Rides / Drivers tabs</dt><dd>Volume across the day — trips and distinct drivers. These have no benchmark (more isn't good or bad on its own), so they're plain today-vs-normal curves. The tint between the lines shows whether the day ran above (blue) or below (grey) typical.</dd>
        <dt>“The three together”</dt><dd>Wait, load, and cancellations on one shared scale, each shown as a multiple of its own target. The dashed line is 1.0× — the benchmark for all three at once. Above it = over benchmark. It's the quickest way to see whether the three move together or apart. The faint shape behind is trip volume, for context.</dd>
        <dt>The read (the coloured box under it)</dt><dd>An automatic plain-language guess at what the three metrics are saying together, and the likeliest cause. It's a rule of thumb, not a verdict — it weighs how often each metric breaches and whether they co-occur, then names the most probable story. Always sanity-check it against the chart.</dd>
      </dl>

      <h3>The three benchmarks</h3>
      <dl>
        <dt>Load</dt><dd>Active trips per active driver. Target ≤ 1.8. Higher means each driver is stretched across more trips — a sign the area needs more drivers.</dd>
        <dt>%Cancel</dt><dd>Share of requested trips the customer cancelled after requesting. Target ≤ 30%. High cancellation usually follows long waits.</dd>
        <dt>Wait time</dt><dd>Minutes from request to driver arrival. Target ≤ 12 min. This is the main customer-experience signal — the thing the whole tool is trying to keep low.</dd>
        <dt>Count / Drivers</dt><dd>Count = number of trips in that 30-min slot (volume). Drivers = distinct driver IDs that got assigned. Neither is good or bad on its own; they give context. Slots under ${ANALYSIS_VOLUME_FLOOR()} trips are flagged “low sample” because one cancellation distorts the rate.</dd>
      </dl>

      <h3>Understaffed vs. surplus</h3>
      <dl>
        <dt>Understaffed</dt><dd>A slot breaching any of the three benchmarks. This is an <em>absolute</em> judgment — over a target is over a target.</dd>
        <dt>Surplus</dt><dd>A <em>count</em> of this area's 30-min slots that are comfortably under every benchmark <em>and</em> among the most slack citywide. <em>Relative</em>: being barely fine doesn't count — only the most over-served slots are surfaced, as the best candidates to pull incentive from. Higher count = more slack slots here.</dd>
        <dt>Critical (in the “across all areas” tiles and the area scoreboard)</dt><dd>The mirror image of Surplus, on the understaffed end — a <em>count</em> of this area's 30-min slots that rank among the most severely understaffed citywide. Not every breach, just the worst ones. <strong>The number is a count of slots, not a rank:</strong> “Critical 11” means 11 of this area's slots are among the worst citywide. Higher = more urgent, same direction as Surplus.</dd>
        <dt>Severity</dt><dd>How far a slot is over the benchmarks (shown +), or how slack it is (shown −). Wait is weighted most because it’s the customer-experience goal.</dd>
      </dl>

      <h3>“Versus recent ___s” — the comparison</h3>
      <dl>
        <dt>What it compares</dt><dd>Each 30-min slot today against the <em>median</em> of the same slot on the same weekday over the prior few weeks (e.g. this Monday 17:00 vs. the median of recent Mondays at 17:00). Median is used so a one-off holiday or spike doesn’t skew the baseline.</dd>
        <dt>Newly understaffed</dt><dd>Fine on recent weeks, breaching today — worth chasing now.</dd>
        <dt>Getting worse</dt><dd>Already understaffed, and worse today than its recent median.</dd>
        <dt>Improving</dt><dd>Still understaffed, but better today than its recent median — moving the right way.</dd>
        <dt>Persistent issue</dt><dd>Understaffed on recent weeks and still today, roughly unchanged — incentives haven’t shifted it; may need a standing change rather than a daily nudge.</dd>
        <dt>Recovered</dt><dd>Was understaffed on recent weeks, fine today.</dd>
        <dt>▲ / ▼ deltas</dt><dd>Change versus the recent-weeks median for that stat. For wait/load/cancel, green = better (lower), red = worse (higher). For count, the arrow is neutral — it’s just volume change.</dd>
      </dl>

      <h3>The recommendation</h3>
      <dl>
        <dt>Anchor incentive block</dt><dd>Incentives are assigned as contiguous shift blocks, not single 30-min slots. Each area gets one suggested window to place or strengthen a block over, with the peak (◆) marking where pressure is highest. It’s directional guidance — where a pay bump pays off most — not an exact driver count.</dd>
        <dt>Reclaim / over-served</dt><dd>A window slack enough to lower the incentive tier and redirect drivers toward the anchor windows.</dd>
      </dl>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById("helpClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } });
  }
  function ANALYSIS_VOLUME_FLOOR() { return (window.Analysis && Analysis.VOLUME_FLOOR) || 15; }

  $("logoutBtn").addEventListener("click", doLogout);
  $("runBtn").addEventListener("click", run);
  $("infoBtn").addEventListener("click", openHelp);

  // restore session if present
  if (getToken()) showApp(); else showLogin();
})();
