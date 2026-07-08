const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

async function list(req, res) {
  const { status = 'open', limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') { params.push(status); conditions.push(`fa.status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT fa.*, u.full_name, u.email, u.phone, t.reference, t.amount, t.created_at AS txn_time
     FROM fraud_alerts fa
     LEFT JOIN users u ON u.id = fa.user_id
     LEFT JOIN transactions t ON t.id = fa.transaction_id
     ${where}
     ORDER BY fa.flagged_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ success: true, data: rows });
}

/** Takes action on a flagged alert: freeze the wallet, block the user, reverse the transaction, or dismiss. */
async function takeAction(req, res) {
  const { action, notes } = req.body; // action: freeze_wallet | block_user | dismiss | mark_reviewing | resolve
  const { rows } = await query('SELECT * FROM fraud_alerts WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('Fraud alert not found.');
  const alert = rows[0];

  await withTransaction(async (client) => {
    if (action === 'freeze_wallet' && alert.user_id) {
      await client.query('UPDATE wallets SET is_frozen = true WHERE user_id = $1', [alert.user_id]);
    }
    if (action === 'block_user' && alert.user_id) {
      await client.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [alert.user_id]);
    }
    const nextStatus = ['freeze_wallet', 'block_user'].includes(action) ? 'resolved'
      : action === 'dismiss' ? 'false_positive'
      : action === 'resolve' ? 'resolved'
      : 'reviewing';
    await client.query(
      `UPDATE fraud_alerts SET status = $1, action_taken = $2, notes = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $5`,
      [nextStatus, action, notes || null, req.admin.id, req.params.id]
    );
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: `FRAUD_ALERT_${action.toUpperCase()}`, targetType: 'fraud_alert', targetId: req.params.id, meta: { notes } });
  res.json({ success: true, message: 'Action recorded.' });
}

module.exports = { list, takeAction };
