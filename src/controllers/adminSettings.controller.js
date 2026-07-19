const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

async function list(req, res) {
  const { rows } = await query(`SELECT key, value, label, updated_at FROM platform_settings ORDER BY key`);
  res.json({ success: true, data: rows });
}

async function update(req, res) {
  const { value } = req.body;
  if (value === undefined) throw ApiError.badRequest('value is required.');
  const { rows } = await query(
    `UPDATE platform_settings SET value = $1, updated_by = $2, updated_at = now() WHERE key = $3 RETURNING *`,
    [JSON.stringify(value), req.admin.id, req.params.key]
  );
  if (!rows.length) throw ApiError.notFound('Setting not found.');
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'SETTINGS_UPDATE', targetType: 'platform_setting', targetId: null, meta: { key: req.params.key, value } });
  res.json({ success: true, data: rows[0] });
}

module.exports = { list, update };
