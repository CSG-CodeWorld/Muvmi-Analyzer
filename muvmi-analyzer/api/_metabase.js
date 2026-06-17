// Shared Metabase helpers (server-side / Vercel functions).
// A browser can't call Metabase directly (CORS); these functions can.
// Auth: POST /api/session -> { id } (the session token). Sent as X-Metabase-Session.
// Login is throttled, so we auth once and reuse the token (held by the client).

const METABASE_BASE = "https://metabase.muvmi.io";
const CARD_ID = 7441;
const DATE_FIELD_ID = 77561;

async function mbFetch(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Metabase-Session"] = token;
  const res = await fetch(`${METABASE_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function login(username, password) {
  const { status, text } = await mbFetch("/api/session", { method: "POST", body: { username, password } });
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Metabase returned non-JSON on login (status ${status}); server may be unreachable.`); }
  if (status === 200 && parsed.id) return parsed.id;
  if (status === 429) throw new Error("Too many login attempts — Metabase is throttling. Wait a minute and retry.");
  if (status === 401 || status === 400) throw new Error("Login failed: incorrect email or password.");
  throw new Error(`Login failed (status ${status}): ${text.slice(0, 200)}`);
}

async function getCardQuery(token) {
  const { status, text } = await mbFetch(`/api/card/${CARD_ID}`, { token });
  if (status === 401) throw new Error("Session expired — please log in again.");
  if (status !== 200) throw new Error(`Could not read card ${CARD_ID} (status ${status}).`);
  const card = JSON.parse(text);
  if (!card.dataset_query) throw new Error("Card has no dataset_query.");
  return card.dataset_query;
}

// Rewrite the date filter (field DATE_FIELD_ID) to a single-day "=" on dateStr (YYYY-MM-DD).
function rewriteDate(datasetQuery, dateStr) {
  const q = JSON.parse(JSON.stringify(datasetQuery));
  const stage = q.stages && q.stages[0];
  if (!stage || !Array.isArray(stage.filters)) throw new Error("Query has no filters array.");
  const hits = (clause) => Array.isArray(clause) &&
    clause.some((p) => Array.isArray(p) && p[0] === "field" && p[p.length - 1] === DATE_FIELD_ID);
  let found = false;
  stage.filters = stage.filters.map((clause) => {
    if (!hits(clause)) return clause;
    found = true;
    const opts = clause[1];
    const fieldRef = clause.find((p) => Array.isArray(p) && p[0] === "field" && p[p.length - 1] === DATE_FIELD_ID);
    return ["=", opts, fieldRef, dateStr];
  });
  if (!found) throw new Error(`Date filter (field ${DATE_FIELD_ID}) not found; card may have changed.`);
  return q;
}

// Run via /api/dataset. NOTE: Metabase returns 202 for a completed async query — treat as success.
// Guard against the silent "200/202 with error body" case seen on this instance.
async function runQuery(token, datasetQuery) {
  const { status, text } = await mbFetch("/api/dataset", { method: "POST", token, body: datasetQuery });
  if (status === 401) throw new Error("Session expired — please log in again.");
  if (status === 403) throw new Error("Metabase refused the query (403): this account may not be allowed to run ad-hoc queries.");
  if (status !== 200 && status !== 202) throw new Error(`Query failed (status ${status}): ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  if (parsed.error || parsed.status === "failed") throw new Error(`Query error: ${(parsed.error || JSON.stringify(parsed)).slice(0, 200)}`);
  const data = parsed.data;
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.cols)) throw new Error("Query response missing data.rows/cols.");
  return { cols: data.cols.map((c) => ({ name: c.name, display_name: c.display_name })), rows: data.rows };
}

module.exports = { METABASE_BASE, CARD_ID, DATE_FIELD_ID, login, getCardQuery, rewriteDate, runQuery };
