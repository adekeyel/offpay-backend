const feeService = require('../services/fee.service');
const auditService = require('../services/audit.service');

async function list(req, res) {
  const fees = await feeService.listFeeConfig();
  res.json({ success: true, data: fees });
}

async function update(req, res) {
  const { feeValue, feeType, minAmount, maxAmount, active } = req.body;
  const updated = await feeService.updateFeeConfig(req.params.id, { feeValue, feeType, minAmount, maxAmount, active }, req.admin.id);
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'FEE_UPDATE', targetType: 'fee_config', targetId: req.params.id, meta: req.body });
  res.json({ success: true, message: 'Fee updated.', data: updated });
}

module.exports = { list, update };
