const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

async function list(req, res) {
  const { status, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (status && status !== 'all') { params.push(status); conditions.push(`r.status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT r.*, u.full_name, u.email, u.phone, a.full_name AS handled_by_name
     FROM recovery_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN admin_users a ON a.id = r.handled_by
     ${where}
     ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ success: true, data: rows });
}

/** Full history/log for one user — every recovery request they've ever raised. */
async function historyForUser(req, res) {
  const { rows } = await query(
    `SELECT r.*, a.full_name AS handled_by_name FROM recovery_requests r
     LEFT JOIN admin_users a ON a.id = r.handled_by
     WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [req.params.userId]
  );
  res.json({ success: true, data: rows });
}

/** Approves a recovery request: for password/PIN resets, sets a temporary credential the user must change on next login. */
async function resolve(req, res) {
  const { decision, notes, temporaryValue } = req.body; // decision: approved | rejected | completed
  if (!['approved', 'rejected', 'completed'].includes(decision)) throw ApiError.badRequest('Invalid decision.');

  const { rows } = await query('SELECT * FROM recovery_requests WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('Recovery request not found.');
  const reqRow = rows[0];

  if (decision === 'approved' && temporaryValue) {
    const hash = await bcrypt.hash(String(temporaryValue), 12);
    if (reqRow.type === 'pin_reset') {
      await query('UPDATE users SET pin_hash = $1 WHERE id = $2', [hash, reqRow.user_id]);
    } else if (reqRow.type === 'password_reset') {
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, reqRow.user_id]);
    }
  }

  await query(
    `UPDATE recovery_requests SET status = $1, resolution_notes = $2, handled_by = $3, handled_at = now() WHERE id = $4`,
    [decision, notes || null, req.admin.id, req.params.id]
  );

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: `RECOVERY_${decision.toUpperCase()}`, targetType: 'recovery_request', targetId: req.params.id, meta: { notes } });
  res.json({ success: true, message: `Recovery request ${decision}.` });
}

module.exports = { list, historyForUser, resolve };
