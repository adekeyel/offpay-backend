const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const auditService = require('../services/audit.service');

/**
 * Eligibility rules (no specific rules were given in the spec beyond "flag
 * if in scope" — this is a reasonable, defensible default, easy to tune
 * later without touching the request/disbursement flow itself):
 *   - KYC tier meets the product's minimum
 *   - Account is at least the product's minimum age
 *   - No existing pending/active loan (one at a time)
 */
async function checkEligibility(userId, loanProduct) {
  const { rows } = await query('SELECT kyc_tier, created_at, status FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) return { eligible: false, reason: 'Account not found.' };
  if (['blocked', 'suspended', 'deleted'].includes(user.status)) return { eligible: false, reason: 'Account is not in good standing.' };
  // Loans are Tier 3 only, enforced here regardless of what any individual loan
  // product's min_kyc_tier is set to in the DB — this is a hard business rule,
  // not a per-product tunable.
  if (user.kyc_tier < 3) return { eligible: false, reason: 'Loans are only available to Tier 3 (fully verified) accounts. Upgrade your KYC tier to apply.' };
  if (user.kyc_tier < loanProduct.min_kyc_tier) return { eligible: false, reason: `Requires KYC Tier ${loanProduct.min_kyc_tier} or higher.` };

  const accountAgeDays = (Date.now() - new Date(user.created_at).getTime()) / 86400000;
  if (accountAgeDays < loanProduct.min_account_age_days) {
    return { eligible: false, reason: `Account must be at least ${loanProduct.min_account_age_days} days old.` };
  }

  const { rows: activeLoans } = await query(
    `SELECT 1 FROM loans WHERE user_id = $1 AND status IN ('pending', 'approved', 'active')`,
    [userId]
  );
  if (activeLoans.length) return { eligible: false, reason: 'You already have an active loan.' };

  return { eligible: true };
}

async function listProducts(req, res) {
  const { rows } = await query('SELECT * FROM loan_products WHERE active = true ORDER BY min_amount');
  // Attach eligibility per product so the app can grey out ones the user doesn't qualify for yet.
  const withEligibility = await Promise.all(rows.map(async (p) => ({ ...p, eligibility: await checkEligibility(req.user.id, p) })));
  res.json({ success: true, data: withEligibility });
}

/**
 * Files a loan request. Loans no longer auto-disburse — this only creates a
 * 'pending' record. An admin must review and approve it (see
 * adminLoans.controller.js) before funds are credited to the user's wallet.
 * due_date is left null here since the tenor clock starts at disbursement,
 * not at request time.
 */
async function requestLoan(req, res) {
  const { loanProductId, amount } = req.body;
  if (!loanProductId || !amount) throw ApiError.badRequest('loanProductId and amount are required.');

  const { rows: productRows } = await query('SELECT * FROM loan_products WHERE id = $1 AND active = true', [loanProductId]);
  if (!productRows.length) throw ApiError.badRequest('Loan product not available.');
  const product = productRows[0];

  const requested = parseFloat(amount);
  if (requested < parseFloat(product.min_amount) || requested > parseFloat(product.max_amount)) {
    throw ApiError.badRequest(`Amount must be between ₦${product.min_amount} and ₦${product.max_amount}.`);
  }

  const eligibility = await checkEligibility(req.user.id, product);
  if (!eligibility.eligible) throw ApiError.forbidden(eligibility.reason);

  const interestAmount = Math.round(requested * (parseFloat(product.interest_rate) / 100) * 100) / 100;
  const totalRepayable = requested + interestAmount;

  const { rows: loanRows } = await query(
    `INSERT INTO loans (user_id, loan_product_id, principal, interest_amount, total_repayable, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
    [req.user.id, loanProductId, requested, interestAmount, totalRepayable]
  );
  const loan = loanRows[0];

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'LOAN_REQUESTED', targetType: 'loan', targetId: loan.id, ipAddress: req.ip });
  res.status(201).json({
    success: true,
    message: `Loan request for ₦${requested.toLocaleString()} submitted and is pending admin approval. You'll be notified once it's reviewed.`,
    data: loan,
  });
}

/** Returns the user's current loan (if any), auto-flagging as defaulted if overdue and unpaid. */
async function getActiveLoan(req, res) {
  const { rows } = await query(
    `SELECT l.*, lp.name AS product_name FROM loans l
     JOIN loan_products lp ON lp.id = l.loan_product_id
     WHERE l.user_id = $1 AND l.status IN ('pending','approved','active','defaulted')
     ORDER BY l.created_at DESC LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) return res.json({ success: true, data: null });

  const loan = rows[0];
  if (loan.status === 'active' && new Date(loan.due_date) < new Date() && parseFloat(loan.amount_repaid) < parseFloat(loan.total_repayable)) {
    await query(`UPDATE loans SET status = 'defaulted' WHERE id = $1`, [loan.id]);
    loan.status = 'defaulted';
  }
  res.json({ success: true, data: loan });
}

async function repay(req, res) {
  const { amount } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('A valid amount is required.');

  const { rows: loanRows } = await query(
    `SELECT * FROM loans WHERE user_id = $1 AND status IN ('active', 'defaulted') ORDER BY created_at DESC LIMIT 1`,
    [req.user.id]
  );
  if (!loanRows.length) throw ApiError.badRequest('No active loan to repay.');
  const loan = loanRows[0];

  const remaining = parseFloat(loan.total_repayable) - parseFloat(loan.amount_repaid);
  const repayAmount = Math.min(parseFloat(amount), remaining);

  const { rows: walletRows } = await query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = walletRows[0];
  if (parseFloat(wallet.balance) < repayAmount) throw ApiError.badRequest('Insufficient balance.');

  const result = await withTransaction(async (client) => {
    const txn = await walletService.debitWallet(client, {
      walletId: wallet.id, amount: repayAmount, fee: 0, type: 'loan_repayment', provider: 'internal',
      narration: `Loan repayment`,
    });
    await client.query('INSERT INTO loan_repayments (loan_id, amount, transaction_id) VALUES ($1,$2,$3)', [loan.id, repayAmount, txn.id]);

    const newAmountRepaid = parseFloat(loan.amount_repaid) + repayAmount;
    const newStatus = newAmountRepaid >= parseFloat(loan.total_repayable) ? 'repaid' : 'active';
    const { rows } = await client.query(
      'UPDATE loans SET amount_repaid = $1, status = $2 WHERE id = $3 RETURNING *',
      [newAmountRepaid, newStatus, loan.id]
    );
    return rows[0];
  });

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'LOAN_REPAYMENT', targetType: 'loan', targetId: loan.id, ipAddress: req.ip });
  res.json({ success: true, message: result.status === 'repaid' ? 'Loan fully repaid.' : `₦${repayAmount.toLocaleString()} repayment received.`, data: result });
}

module.exports = { listProducts, requestLoan, getActiveLoan, repay };
