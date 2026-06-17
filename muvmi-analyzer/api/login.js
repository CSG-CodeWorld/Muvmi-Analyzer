// POST /api/login  { username, password } -> { token }
// The token is returned to the browser, which holds it (sessionStorage) and sends it
// back on subsequent /api/pull calls. The raw password is never stored anywhere.
const { login } = require("./_metabase");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Missing email or password." });
    const token = await login(username, password);
    return res.status(200).json({ token });
  } catch (err) {
    return res.status(200).json({ error: err.message });
  }
};
