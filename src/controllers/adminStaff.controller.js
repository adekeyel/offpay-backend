const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

const ROLES = ['admin', 'support', 'compliance', 'finance', 'operations', 'fraud', 'recovery'];

/** Full staff directory: every admin's name, role, email, and status. */
async function list(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, role, status, last_login_at, created_at FROM admin_users ORDER BY created_at DESC`
  );
  res.json({ success: true, data: rows, meta: { roles: ROLES } });
}

/** Change an existing staff member's role. */
async function updateRole(req, res) {
  const { role } = req.body;
  if (!ROLES.includes(role)) throw ApiError.badRequest(`role must be one of: ${ROLES.join(', ')}`);
  const { rows } = await query(
    `UPDATE admin_users SET role = $1, updated_at = now() WHERE id = $2 RETURNING id, full_name, email, role`,
    [role, req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('Admin not found.');
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'STAFF_ROLE_UPDATE', targetType: 'admin_user', targetId: req.params.id, meta: { role } });
  res.json({ success: true, data: rows[0] });
}

/** Suspend or reactivate a staff account. */
async function updateStatus(req, res) {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) throw ApiError.badRequest('status must be "active" or "suspended".');
  if (req.params.id === req.admin.id) throw ApiError.badRequest('You cannot change your own account status.');
  const { rows } = await query(
    `UPDATE admin_users SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, full_name, email, role, status`,
    [status, req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('Admin not found.');
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'STAFF_STATUS_UPDATE', targetType: 'admin_user', targetId: req.params.id, meta: { status } });
  res.json({ success: true, data: rows[0] });
}

module.exports = { list, updateRole, updateStatus, ROLES };
