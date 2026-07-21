const { query } = require('../config/db');
const logger = require('../utils/logger');

/**
 * Creates a row on the client-facing Notifications screen (see
 * user_notifications in schema.sql). Fire-and-forget: a notification failing
 * to write must never break the action that triggered it (login, a support
 * reply, a KYC decision, etc.), so this always swallows its own errors.
 */
async function notifyUser({ userId, type, title, message, relatedType = null, relatedId = null }) {
  try {
    await query(
      `INSERT INTO user_notifications (user_id, type, title, message, related_type, related_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, type, title, message, relatedType, relatedId]
    );
  } catch (err) {
    logger.warn(`notifyUser failed: ${err.message}`);
  }
}

/**
 * Creates a row on the admin Notifications bell (see notifications table).
 * targetRole = null means every admin role sees it. Same fire-and-forget
 * guarantee as notifyUser above.
 */
async function notifyAdmins({ title, message, severity = 'info', targetRole = null, relatedType = null, relatedId = null }) {
  try {
    await query(
      `INSERT INTO notifications (title, message, severity, target_role, related_type, related_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [title, message, severity, targetRole, relatedType, relatedId]
    );
  } catch (err) {
    logger.warn(`notifyAdmins failed: ${err.message}`);
  }
}

module.exports = { notifyUser, notifyAdmins };
