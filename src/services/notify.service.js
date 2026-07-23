const { query } = require('../config/db');
const logger = require('../utils/logger');
const mailerService = require('./mailer.service');

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
 * Creates a row on the admin Notifications bell (see notifications table)
 * AND emails the relevant staff — every notifyAdmins() call already covers
 * new support message, tier upgrade request, fraud alert, and new
 * registration (see support.controller.js, user.controller.js,
 * auth.controller.js, fraud.service.js), so wiring email in here covers all
 * of them without touching each call site.
 *
 * targetRole = null means every admin role sees/gets emailed about it.
 * Regardless of targetRole, every 'admin' (super-admin) role account is
 * always included in both the in-app feed (see adminNotifications.controller.js
 * list()) and the email — super admin should never miss an alert scoped to
 * another department.
 *
 * Same fire-and-forget guarantee as notifyUser above: a failed insert or
 * email must never break the action that triggered it.
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

  try {
    const { rows } = await query(
      `SELECT DISTINCT email FROM admin_users
       WHERE status = 'active' AND (role = 'admin' OR $1::text IS NULL OR role = $1)`,
      [targetRole]
    );
    await Promise.all(rows.map((r) =>
      mailerService.sendGenericEmail(r.email, `[OffPay Admin] ${title}`, message)
        .catch((err) => logger.warn(`notifyAdmins email to ${r.email} failed: ${err.message}`))
    ));
  } catch (err) {
    logger.warn(`notifyAdmins email lookup failed: ${err.message}`);
  }
}

module.exports = { notifyUser, notifyAdmins };
