// POST /api/pull  { token, date }  -> { cols, rows }
// Pulls card 7441's data for a single date by rewriting the date filter and running
// it via /api/dataset. One date per call — the frontend calls this once per date
// (today + comparison weeks) so each heavy query is its own request.
//
// NOTE: no module-level cache. A previous version cached the card definition at module
// scope to save a fetch, but module state persists across requests on a warm Vercel
// instance, so one failed/slow call could leave bad state that affected later calls in
// the same instance ("works again after refresh"). Each request now fetches the card
// fresh in its own scope — one extra sub-second /api/card call, zero shared state.
const { getCardQuery, rewriteDate, runQuery } = require("./_metabase");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { token, date } = req.body || {};
    if (!token) return res.status(401).json({ error: "Not logged in." });
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Bad date (need YYYY-MM-DD)." });

    const cardQuery = await getCardQuery(token);
    const query = rewriteDate(cardQuery, date);
    const result = await runQuery(token, query);
    return res.status(200).json({ date, cols: result.cols, rows: result.rows });
  } catch (err) {
    return res.status(200).json({ error: err.message });
  }
};
