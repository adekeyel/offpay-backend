const { query } = require('../config/db');

/**
 * Deliberately returns only masked_pan/last4/brand/expiry/status — never a
 * full PAN or CVV, which this system never stores in the first place (see
 * the comment on the cards table in schema.sql). This endpoint is for
 * support/compliance/ops to confirm a card exists, its status, and help a
 * user freeze/block it — not to see the number itself.
 */
async function getUserCards(req, res) {
  const { rows } = await query(
    `SELECT id, masked_pan, last4, brand, expiry_month, expiry_year, status, created_at
     FROM cards WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.params.userId]
  );
  res.json({ success: true, data: rows });
}

module.exports = { getUserCards };
