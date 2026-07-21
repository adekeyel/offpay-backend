const { query } = require('../config/db');

/** Every notification for the logged-in user — login alerts, app/update announcements, support replies. */
async function list(req, res) {
  const { rows } = await query(
    `SELECT id, type, title, message, related_type, related_id, is_read, created_at
     FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
}

/** Small badge-count helper so the app can show an unread dot/number without pulling the full list. */
async function unreadCount(req, res) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM user_notifications WHERE user_id = $1 AND is_read = false`,
    [req.user.id]
  );
  res.json({ success: true, data: { count: rows[0].count } });
}

async function markRead(req, res) {
  await query(`UPDATE user_notifications SET is_read = true WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
  res.json({ success: true });
}

async function markAllRead(req, res) {
  await query(`UPDATE user_notifications SET is_read = true WHERE user_id = $1 AND is_read = false`, [req.user.id]);
  res.json({ success: true });
}

module.exports = { list, unreadCount, markRead, markAllRead };
