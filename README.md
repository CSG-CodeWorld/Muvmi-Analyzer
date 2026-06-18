# Area Performance Analyzer — MuvMi

Daily area-performance analysis on top of Metabase card **7441**
(`load-cancel-wait-time-by-area-30min`). Pick a date, pull the data, get a
ranked view of where to add driver incentives, where to pull them back, and how
each area compares to the median of prior weeks.

## What it does

- **Sign in** with a Metabase account (the supervisor uses their own credentials;
  nothing is stored — only a temporary session token is kept in the browser so you
  stay logged in until you log out).
- **Pick a date** (defaults to yesterday). Optionally compare to the median of the
  same weekday over the last 3–4 weeks (the methodology from the brief — washes out
  one-off holidays/spikes).
- **Run** — pulls the data live (each day's query takes ~15–20s on Metabase, so a
  comparison run takes 1–2 min). Progress shows in the page title with a ✓ when done,
  and a browser notification fires if the tab is in the background.
- **Read the report:**
  - *Bump incentive here* — buckets breaching targets, ranked by severity. Buckets
    where wait is high but load is low are flagged `wait, not load` (an incentive
    likely won't fix those).
  - *Can pull incentive here* — over-served buckets to reclaim incentive from.
  - *Watch* — buckets breaching targets on too few trips to trust (kept out of the
    ranking on purpose).
  - *Area rollup* — volume-weighted day averages, structural vs one-off problems.
  - *Full grid* — the raw pulled data, color-coded, for auditing against Metabase.

Targets: Load ≤ 1.8 · %Cancel ≤ 30% · Wait ≤ 12 min.

## Deploy (one time, ~10 min)

1. Put this folder in a GitHub repo (see steps below).
2. Go to **vercel.com**, sign in with GitHub, **Add New → Project**, import the repo.
3. Accept defaults and **Deploy**. You get a URL like `https://your-app.vercel.app`.
4. Open the URL, sign in with a Metabase account, and run.

No environment variables, no secrets to configure — credentials are entered at
sign-in by whoever uses it.

### Push to GitHub

```bash
cd muvmi-analyzer
git init
git add .
git commit -m "Area performance analyzer"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## How it works (for the next person)

- `api/_metabase.js` — auth, reads card 7441's query definition, rewrites the date
  filter, runs it via `/api/dataset`. Handles Metabase quirks: 202 = success (async),
  and the "HTTP 200 with an error body" trap is guarded against.
- `api/login.js`, `api/pull.js` — thin serverless endpoints.
- `public/analysis.js` — the scoring/ranking engine. Pure, testable. Reads columns by
  name (`avg`=wait, `avg_2`=load, `%Cancel`, `count`, `count_2`=distinct drivers), so
  it survives column reordering. Areas are read dynamically (there are 11, not the 5
  on the slides).
- `public/index.html`, `public/app.js` — the UI.

The date is changed by rewriting the card's own MBQL query (the date is a hardcoded
filter on field 77561, not a parameter), so the card definition is always read live —
if someone edits the card in Metabase, this stays in sync.
