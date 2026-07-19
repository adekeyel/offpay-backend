const { query } = require('../config/db');

/** No auth required — ad slots render on the public landing page too. */
async function getForSlot(req, res) {
  const { page, position } = req.query;
  if (!page || !position) return res.json({ success: true, data: [] });

  const { rows } = await query(
    `SELECT id, title, media_type, media_url, link_url FROM ads
     WHERE target_page = $1 AND position = $2 AND active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at >= now())
     ORDER BY created_at DESC`,
    [page, position]
  );
  res.json({ success: true, data: rows });
}

module.exports = { getForSlot };
