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
    const s = a.summary;
    const T = a.targets;
    let html = "";

    // SUMMARY
    html += `<section>
      <div class="eyebrow">Summary · ${escapeHtml(opts.date)}${opts.compare ? ` · vs median of ${opts.weeks} prior ${weekdayName(opts.date)}s` : ""}</div>
      <div class="tiles">
        <div class="tile"><div class="n">${fmt.int(s.totalTrips)}</div><div class="l">trips</div></div>
        <div class="tile"><div class="n">${s.areas}</div><div class="l">areas</div></div>
        <div class="tile ${s.criticalCount ? "alert" : "good"}"><div class="n">${s.criticalCount}</div><div class="l">critical buckets</div></div>
        <div class="tile ${s.addCount ? "alert" : ""}"><div class="n">${s.addCount}</div><div class="l">need more drivers</div></div>
        <div class="tile good"><div class="n">${s.pullCount}</div><div class="l">over-served</div></div>
        <div class="tile"><div class="n">${s.watchCount}</div><div class="l">low-sample</div></div>
      </div>
    </section>`;

    // ---- DAY STRIPS (the hero) ----
    html += `<section>
      <div class="eyebrow">Incentive windows · ${escapeHtml(opts.date)}</div>
      <h2 class="section-title">Where to anchor incentive blocks</h2>
      <div class="section-note">Each area's day at a glance — color is severity (green = healthy, red = under-served). Incentives are shift blocks, so the call-outs are contiguous windows, not single slots. Peak marks where pressure is highest.</div>
      ${stripLegend()}`;
    for (const strip of a.strips) html += stripBlock(strip, opts.compare);
    html += `</section>`;

    // ---- DETAILS (collapsed) ----
    html += `<section><details><summary class="details-toggle">Detail — ranked buckets, week-over-week changes, area rollup, raw grid</summary><div style="margin-top:16px">`;

    if (opts.compare && a.transitions) {
      const t = a.transitions;
      const wd = weekdayName(opts.date);
      html += `<section>
        <div class="eyebrow">Versus recent ${wd}s</div>
        <h2 class="section-title">What changed week over week</h2>
        <div class="section-note">Each bucket compared to the median of the prior ${opts.weeks} ${wd}s. "Problem" = breaching any target. This answers what's new, what's chronic, and what's recovered — so you're not eyeballing deltas.</div>`;

      html += transitionGroup("New problems", "Fine on recent " + wd + "s, breaching today — worth chasing now.", t.newlyBroken, "add");
      html += transitionGroup("Getting worse", "Already a problem, and worse today than its recent median — escalating.", t.worsening, "add");
      html += transitionGroup("Still a problem, but improving", "Breaching both then and now, but better today than its median — moving the right way.", t.improving, "watch");
      html += transitionGroup("Chronic (holding flat)", "Breaching then and now, roughly unchanged — incentives haven't shifted these; may need a standing change.", t.flat, "watch");
      html += transitionGroup("Recovered", "Was breaching on recent " + wd + "s, fine today — attention here is paying off.", t.fixed, "pull");
      html += `</section>`;
    }

    // ADD LIST
    html += `<section>
      <div class="eyebrow">Priority</div>
      <h2 class="section-title">Bump incentive here</h2>
      <div class="section-note">Under-served buckets breaching targets, by severity. A pay bump should pull drivers toward the top of this list. Flagged buckets have high wait but low load — incentives may not fix those.</div>`;
    if (!a.addList.length) html += `<div class="empty">No buckets breaching targets with adequate volume. Good day.</div>`;
    const maxSev = a.addList.length ? a.addList[0].severity : 1;
    for (const b of a.addList.slice(0, 25)) html += actionRow(b, "add", maxSev, opts.compare);
    if (a.addList.length > 25) html += `<div class="empty">…and ${a.addList.length - 25} more.</div>`;
    html += `</section>`;

    // PULL LIST
    html += `<section>
      <div class="eyebrow">Reclaim</div>
      <h2 class="section-title">Can pull incentive here</h2>
      <div class="section-note">Over-served buckets — low load, short waits, few cancellations. Incentive here can be reduced and redirected to the priority list.</div>`;
    if (!a.pullList.length) html += `<div class="empty">No clearly over-served buckets.</div>`;
    for (const b of a.pullList.slice(0, 20)) html += actionRow(b, "pull", 1, opts.compare);
    html += `</section>`;

    // WATCH LIST
    if (a.watchList.length) {
      html += `<section>
        <div class="eyebrow">Low confidence</div>
        <h2 class="section-title">Watch — too few trips to act on</h2>
        <div class="section-note">These breach targets but on fewer than ${a.volumeFloor} trips, so a single cancellation or slow ride distorts the rate. Kept out of the ranking on purpose.</div>`;
      for (const b of a.watchList.slice(0, 15)) html += actionRow(b, "watch", 1, opts.compare);
      html += `</section>`;
    }

    // AREA ROLLUP
    html += `<section>
      <div class="eyebrow">By area</div>
      <h2 class="section-title">Area rollup</h2>
      <div class="section-note">Volume-weighted day averages. Distinguishes a structurally strained area (many buckets breaching) from one with a single bad slot.</div>
      <div class="gridwrap"><table><thead><tr>
        <th class="area">Area</th><th>Trips</th><th>Avg wait</th><th>Avg load</th><th>Avg cancel</th><th>Breaching</th>
      </tr></thead><tbody>`;
    for (const r of a.areaRollup) {
      const lowVol = r.trips < a.volumeFloor * 3;
      html += `<tr>
        <td class="area">${escapeHtml(r.area)}${lowVol ? ' <span class="hour">(low volume)</span>' : ""}</td>
        <td><span class="cell" style="background:${rampColor(r.avgWait, 5, 15)}">${fmt.wait(r.avgWait)}</span></td>
        <td><span class="cell" style="background:${rampColor(r.avgLoad, 1, 2.3)}">${fmt.load(r.avgLoad)}</span></td>
        <td><span class="cell" style="background:${rampColor(r.avgCancel, 0.1, 0.4)}">${fmt.pct(r.avgCancel)}</span></td>
        <td>${r.breachBuckets}/${r.totalBuckets}</td>
      </tr>`;
    }
    html += `</tbody></table></div></section>`;

    // FULL GRID (auditable raw data, collapsed)
    html += `<section>
      <div class="eyebrow">Source</div>
      <details><summary>Full data grid (${a.buckets.length} buckets) — for auditing against Metabase</summary>
      ${fullGrid(a)}
      </details>
    </section>`;

    // close the DETAILS wrapper opened after the strips
    html += `</div></details></section>`;

    $("report").innerHTML = html;
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
    // Build the colored strip of half-hour cells.
    let bar = `<div class="strip">`;
    for (const c of cells) {
      let bg, cls = "strip-cell";
      if (c.lowSample) { bg = "transparent"; cls += " lowsample"; }
      else bg = rampColor(c.wait > 12 || c.load > 1.8 || c.cancel > 0.3 ? Math.max(c.wait, 5) : c.wait, 5, 20);
      // Use severity for richer coloring on under cells; over cells stay green.
      if (!c.lowSample) {
        if (c.state === "over") bg = "var(--good)";
        else if (c.state === "ok") bg = "#cfd8d0";
        else bg = sevToColor(c.severity);
      }
      const isPeak = strip.underWindows.some((w) => w.peakHour === c.hour);
      bar += `<div class="${cls}" style="background:${bg}" title="${escapeHtml(c.hour)} · wait ${c.wait.toFixed(1)} · load ${c.load.toFixed(2)} · cancel ${(c.cancel*100).toFixed(0)}% · n ${c.count}">${isPeak ? '<span class="peak">◆</span>' : ""}</div>`;
    }
    bar += `</div>`;

    // Hour ticks (start, a few midpoints, end)
    const ticks = `<div class="strip-ticks">${cells.map((c, i) =>
      (i === 0 || i === cells.length - 1 || c.hour.endsWith(":00") && i % 2 === 0)
        ? `<span style="flex:1;text-align:${i===0?'left':i===cells.length-1?'right':'center'}">${c.hour}</span>` : `<span style="flex:1"></span>`
    ).join("")}</div>`;

    // Recommendations
    let recs = `<div class="strip-recs">`;
    if (strip.underWindows.length) {
      for (const w of strip.underWindows) {
        recs += `<div class="rec rec-under"><b>Under-served ${w.start}–${w.end}</b> · peak ${w.peakHour} — anchor an incentive block over this window${w.maxSeverity > 0.5 ? ", strong tier" : ""}.</div>`;
      }
    }
    if (strip.overWindows.length) {
      for (const w of strip.overWindows) {
        recs += `<div class="rec rec-over"><b>Over-served ${w.start}–${w.end}</b> — lower tier or no incentive; reclaim for the windows above.</div>`;
      }
    }
    if (!strip.underWindows.length && !strip.overWindows.length) {
      recs += `<div class="rec rec-ok">Steady across the day — no block change indicated.</div>`;
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
