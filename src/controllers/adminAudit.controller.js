const auditService = require('../services/audit.service');

async function list(req, res) {
  const { limit = 100, offset = 0, actorType, action } = req.query;
  const logs = await auditService.listAuditLogs({ limit: parseInt(limit), offset: parseInt(offset), actorType, action });
  res.json({ success: true, data: logs });
}

module.exports = { list };
