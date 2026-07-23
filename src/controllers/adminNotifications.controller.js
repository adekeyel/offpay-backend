const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

/**
 * Lists notifications visible to the current admin.
 * Super-admin ('admin' role) sees every notification regardless of
 * target_role — this used to filter on `target_role IS NULL OR target_role =
 * role`, which for an 'admin' role meant only rows scoped to null/'admin'
 * ever showed up. Every real trigger (new support message, tier upgrade
 * request, fraud alert, new registration) scopes targetRole to
 * 'support'/'compliance'/'fraud' instead, so super-admin's feed was always
 * empty of exactly the alerts that matter, even though the email side
 * already reached them correctly (see notify.service.js).
 */
async function list(req, res) {
  const isSuperAdmin = req.admin.role === 'admin';
  const { rows } = await query(
    `SELECT n.*, (nr.admin_id IS NOT NULL) AS is_read
     FROM notifications n
     LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.admin_id = $1
     WHERE $2 OR n.target_role IS NULL OR n.target_role = $3
     ORDER BY n.created_at DESC LIMIT 100`,
    [req.admin.id, isSuperAdmin, req.admin.role]
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

/**
 * admin-role only: broadcasts to every user's Notifications screen — used for
 * general app announcements ('app') and app-update notices ('update'). Fans
 * out one user_notifications row per user, so each user's read state is
 * independent.
 */
async function broadcastToUsers(req, res) {
  const { title, message, type = 'app' } = req.body;
  if (!title || !message) throw ApiError.badRequest('title and message are required.');
  if (!['app', 'update'].includes(type)) throw ApiError.badRequest(`type must be one of: app, update`);

  const { rowCount } = await query(
    `INSERT INTO user_notifications (user_id, type, title, message)
     SELECT id, $1, $2, $3 FROM users WHERE status != 'deleted'`,
    [type, title, message]
  );
  res.status(201).json({ success: true, message: `Sent to ${rowCount} user(s).` });
}

module.exports = { list, markRead, create, broadcastToUsers };
