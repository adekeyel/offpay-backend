const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

async function listLoanProducts(req, res) {
  const { rows } = await query('SELECT * FROM loan_products ORDER BY name ASC');
  res.json({ success: true, data: rows });
}

/**
 * interest_rate here is a flat % of principal for the whole loan tenor
 * (see db/schema.sql's comment on loan_products) — not an annualized rate.
 */
async function updateLoanProduct(req, res) {
  const { interestRate, minAmount, maxAmount, tenorDays, minKycTier, minAccountAgeDays, active } = req.body;
  const { rows } = await query(
    `UPDATE loan_products SET
       interest_rate = COALESCE($1, interest_rate),
       min_amount = COALESCE($2, min_amount),
       max_amount = COALESCE($3, max_amount),
       tenor_days = COALESCE($4, tenor_days),
       min_kyc_tier = COALESCE($5, min_kyc_tier),
       min_account_age_days = COALESCE($6, min_account_age_days),
       active = COALESCE($7, active)
     WHERE id = $8
     RETURNING *`,
    [interestRate, minAmount, maxAmount, tenorDays, minKycTier, minAccountAgeDays, active, req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('Loan product not found.');

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'LOAN_PRODUCT_RATE_UPDATE',
    targetType: 'loan_product', targetId: req.params.id, meta: req.body,
  });
  res.json({ success: true, message: 'Loan product updated.', data: rows[0] });
}

async function listWealthProducts(req, res) {
  const { rows } = await query('SELECT * FROM wealth_products ORDER BY name ASC');
  res.json({ success: true, data: rows });
}

/** interest_rate here is annualized % (see db/schema.sql's comment on wealth_products). */
async function updateWealthProduct(req, res) {
  const { interestRate, minAmount, lockDays, active } = req.body;
  const { rows } = await query(
    `UPDATE wealth_products SET
       interest_rate = COALESCE($1, interest_rate),
       min_amount = COALESCE($2, min_amount),
       lock_days = COALESCE($3, lock_days),
       active = COALESCE($4, active)
     WHERE id = $5
     RETURNING *`,
    [interestRate, minAmount, lockDays, active, req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('Wealth product not found.');

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'WEALTH_PRODUCT_RATE_UPDATE',
    targetType: 'wealth_product', targetId: req.params.id, meta: req.body,
  });
  res.json({ success: true, message: 'Wealth product updated.', data: rows[0] });
}

module.exports = { listLoanProducts, updateLoanProduct, listWealthProducts, updateWealthProduct };
