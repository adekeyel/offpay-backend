const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const auditService = require('../services/audit.service');
const mailer = require('../services/mailer.service');

/** Pending loan requests awaiting admin review. */
async function listPending(req, res) {
  const { rows } = await query(
    `SELECT l.*, lp.name AS product_name, lp.tenor_days, u.full_name, u.email, u.phone, u.kyc_tier
     FROM loans l
     JOIN loan_products lp ON lp.id = l.loan_product_id
     JOIN users u ON u.id = l.user_id
     WHERE l.status = 'pending'
     ORDER BY l.created_at ASC`
  );
  res.json({ success: true, data: rows });
}

/** Full loan history across every status, for admin review/reporting. */
async function listAll(req, res) {
  const { status } = req.query;
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`l.status = $${params.length}`); }

  const { rows } = await query(
    `SELECT l.*, lp.name AS product_name, u.full_name, u.email
     FROM loans l
     JOIN loan_products lp ON lp.id = l.loan_product_id
     JOIN users u ON u.id = l.user_id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY l.created_at DESC`,
    params
  );
  res.json({ success: true, data: rows });
}

/**
 * Approves a pending loan and disburses it in the same step — this is the
 * only place loan funds actually get credited to a user's wallet. Re-checks
 * the Tier 3 rule at approval time too, since a user's KYC tier could in
 * theory change between request and review.
 */
async function approve(req, res) {
  const { rows: loanRows } = await query(
    `SELECT l.*, lp.name AS product_name, lp.tenor_days FROM loans l
     JOIN loan_products lp ON lp.id = l.loan_product_id
     WHERE l.id = $1`,
    [req.params.id]
  );
  if (!loanRows.length) throw ApiError.notFound('Loan request not found.');
  const loan = loanRows[0];
  if (loan.status !== 'pending') throw ApiError.conflict(`This loan is already ${loan.status} — only pending requests can be approved.`);

  const { rows: userRows } = await query('SELECT kyc_tier, status, email, full_name FROM users WHERE id = $1', [loan.user_id]);
  const user = userRows[0];
  if (!user) throw ApiError.notFound('Borrower account not found.');
  if (user.kyc_tier < 3) throw ApiError.forbidden('This user is no longer Tier 3 — loans require Tier 3 KYC. Reject this request instead.');
  if (['blocked', 'suspended', 'deleted'].includes(user.status)) throw ApiError.forbidden('This user\u2019s account is not in good standing.');

  const wallet = await walletService.getWalletByUserId(loan.user_id);
  const dueDate = new Date(Date.now() + loan.tenor_days * 86400000);

  const result = await withTransaction(async (client) => {
    const txn = await walletService.creditWallet(client, {
      walletId: wallet.id, amount: loan.principal, type: 'loan_disbursement', provider: 'internal',
      narration: `${loan.product_name} loan disbursement (admin-approved)`,
    });
    const { rows } = await client.query(
      `UPDATE loans SET status = 'active', disbursement_transaction_id = $1, disbursed_at = now(), due_date = $2,
              reviewed_by = $3, reviewed_at = now()
       WHERE id = $4 RETURNING *`,
      [txn.id, dueDate, req.admin.id, loan.id]
    );
    return rows[0];
  });

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'LOAN_APPROVED_AND_DISBURSED',
    targetType: 'loan', targetId: loan.id, meta: { principal: loan.principal, userId: loan.user_id },
  });
  await mailer.sendGenericEmail(user.email, 'Your OffPay loan has been approved',
    `Hi ${user.full_name}, your ₦${parseFloat(loan.principal).toLocaleString()} loan request has been approved and disbursed to your wallet. Repay ₦${parseFloat(loan.total_repayable).toLocaleString()} by ${dueDate.toDateString()}.`
  ).catch(() => {});

  res.json({ success: true, message: `Loan approved and ₦${parseFloat(loan.principal).toLocaleString()} disbursed.`, data: result });
}

/** Rejects a pending loan request — no wallet movement, nothing to reverse. */
async function reject(req, res) {
  const { reason } = req.body;
  if (!reason) throw ApiError.badRequest('A rejection reason is required.');

  const { rows } = await query(
    `UPDATE loans SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), rejection_reason = $2
     WHERE id = $3 AND status = 'pending' RETURNING *`,
    [req.admin.id, reason, req.params.id]
  );
  if (!rows.length) throw ApiError.conflict('This loan is not pending (already reviewed, or does not exist).');

  const { rows: userRows } = await query('SELECT email, full_name FROM users WHERE id = $1', [rows[0].user_id]);
  if (userRows.length) {
    await mailer.sendGenericEmail(userRows[0].email, 'Your OffPay loan request was not approved',
      `Hi ${userRows[0].full_name}, your loan request could not be approved. Reason: ${reason}`
    ).catch(() => {});
  }

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'LOAN_REJECTED',
    targetType: 'loan', targetId: rows[0].id, meta: { reason },
  });
  res.json({ success: true, message: 'Loan request rejected.', data: rows[0] });
}

module.exports = { listPending, listAll, approve, reject };
