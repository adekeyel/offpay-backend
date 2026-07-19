const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

/** Lists notifications visible to the current admin's role (or broadcast to everyone), with a read flag. */
async function list(req, res) {
  const { rows } = await query(
    `SELECT n.*, (nr.admin_id IS NOT NULL) AS is_read
     FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.admin_id = $1
     WHERE n.target_role IS NULL OR n.target_role = $2
     ORDER BY n.created_at DESC LIMIT 100`,
    [req.admin.id, req.admin.role]
  );
  res.json({ success: true, data: rows });
}

async function markRead(req, res) {
  await query(
    `INSERT INTO notification_reads (notification_id, admin_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.params.id, req.admin.id]
  );
  res.json({ success: true });
}

/** admin-role only: broadcast an internal notification, optionally scoped to one role. */
async function create(req, res) {
  const { title, message, severity = 'info', targetRole } = req.body;
  if (!title || !message) throw ApiError.badRequest('title and message are required.');
  const { rows } = await query(
    `INSERT INTO notifications (title, message, severity, target_role) VALUES ($1,$2,$3,$4) RETURNING *`,
    [title, message, severity, targetRole || null]
  );
  res.status(201).json({ success: true, data: rows[0] });
}

module.exports = { list, markRead, create };
