const { query } = require('../config/db');

async function logAction({ actorType, actorId, action, targetType, targetId, meta, ipAddress }) {
  await query(
    `INSERT INTO audit_logs (actor_type, actor_id, action, target_type, target_id, meta, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorType, actorId || null, action, targetType || null, targetId || null, meta || {}, ipAddress || null]
  );
}

async function listAuditLogs({ limit = 100, offset = 0, actorType, action }) {
  const conditions = [];
  const params = [];
  if (actorType) { params.push(actorType); conditions.push(`actor_type = $${params.length}`); }
  if (action) { params.push(action); conditions.push(`action = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

module.exports = { logAction, listAuditLogs };
