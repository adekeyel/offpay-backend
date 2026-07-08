const { query } = require('../config/db');

/**
 * Admin-facing transaction ledger.
 * Columns requested: time, user id, reference, narration, sender, receiver, bank, amount, fee, status.
 * "Sender"/"receiver" are derived from direction — for a debit the wallet owner is the sender and the
 * stored counterparty is the receiver; for a credit it's the reverse.
 */
async function list(req, res) {
  const { search, status, type, from, to, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
  if (type) { params.push(type); conditions.push(`t.type = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`t.created_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`t.created_at <= $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    conditions.push(`(t.reference ILIKE $${i} OR u.full_name ILIKE $${i} OR u.id::text ILIKE $${i} OR t.counterparty_name ILIKE $${i} OR t.narration ILIKE $${i})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT
       t.id, t.created_at AS time, t.reference, t.narration, t.direction, t.type,
       t.amount, t.fee, t.status,
       u.id AS user_id, u.full_name AS user_name,
       t.counterparty_name, t.counterparty_bank, t.counterparty_number,
       CASE WHEN t.direction = 'debit' THEN u.full_name ELSE t.counterparty_name END AS sender,
       CASE WHEN t.direction = 'debit' THEN t.counterparty_name ELSE u.full_name END AS receiver,
       t.counterparty_bank AS bank
     FROM transactions t
     JOIN wallets w ON w.id = t.wallet_id
     JOIN users u ON u.id = w.user_id
     ${where}
     ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id ${where}`,
    params.slice(0, params.length - 2)
  );
  res.json({ success: true, data: rows, meta: { total: parseInt(countRows[0].count, 10) } });
}

module.exports = { list };
