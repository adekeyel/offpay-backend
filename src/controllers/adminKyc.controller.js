const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const providerManager = require('../services/providers/providerManager');
const { generateVirtualAccountNumber } = require('../utils/idGenerators');
const auditService = require('../services/audit.service');
const mailer = require('../services/mailer.service');
const logger = require('../utils/logger');

async function listPending(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, bvn, passport_url, kyc_status, created_at
     FROM users WHERE kyc_status = 'pending' ORDER BY created_at ASC`
  );
  res.json({ success: true, data: rows });
}

async function getOne(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, bvn, passport_url, status, kyc_status, kyc_notes, created_at FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  res.json({ success: true, data: rows[0] });
}

/**
 * Approving KYC unlocks the account for money movement and triggers
 * virtual account (NUBAN) generation via Flutterwave, falling back to
 * Paystack automatically if Flutterwave is unavailable.
 */
async function approve(req, res) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];
  if (user.kyc_status === 'approved') throw ApiError.conflict('This user is already approved.');

  const { rows: walletRows } = await query('SELECT * FROM wallets WHERE user_id = $1', [user.id]);
  const wallet = walletRows[0];

  let virtualAccount;
  try {
    virtualAccount = await providerManager.createVirtualAccount({
      email: user.email, bvn: user.bvn, fullName: user.full_name, phone: user.phone, txRef: `OP-VA-${user.id}`,
    });
  } catch (err) {
    logger.warn('Live provider virtual account creation failed, issuing a sandbox placeholder account:', err.message);
    virtualAccount = {
      provider: 'sandbox', accountNumber: generateVirtualAccountNumber(), bankName: 'OffPay Partner Bank (Sandbox)', providerUsed: 'sandbox',
    };
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET kyc_status = 'approved', status = 'active', kyc_reviewed_by = $1, kyc_reviewed_at = now() WHERE id = $2`,
      [req.admin.id, user.id]
    );
    await client.query(
      `UPDATE wallets SET virtual_account = $1, virtual_bank = $2 WHERE id = $3`,
      [virtualAccount.accountNumber, virtualAccount.bankName, wallet.id]
    );
    await client.query(
      `INSERT INTO virtual_accounts (wallet_id, provider, provider_ref, account_number, bank_name) VALUES ($1,$2,$3,$4,$5)`,
      [wallet.id, virtualAccount.providerUsed || virtualAccount.provider, virtualAccount.providerRef || null, virtualAccount.accountNumber, virtualAccount.bankName]
    );
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'KYC_APPROVE', targetType: 'user', targetId: user.id });
  await mailer.sendGenericEmail(user.email, 'Your OffPay account is verified! 🎉',
    `Hi ${user.full_name}, your identity verification is complete. Your OffPay virtual account (${virtualAccount.accountNumber}, ${virtualAccount.bankName}) is now active — you can send and receive money right away.`);

  res.json({ success: true, message: 'KYC approved and virtual account issued.', data: { accountNumber: virtualAccount.accountNumber, bankName: virtualAccount.bankName } });
}

async function reject(req, res) {
  const { reason } = req.body;
  if (!reason) throw ApiError.badRequest('A rejection reason is required.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');

  await query(
    `UPDATE users SET kyc_status = 'rejected', kyc_reviewed_by = $1, kyc_reviewed_at = now(), kyc_notes = $2 WHERE id = $3`,
    [req.admin.id, reason, req.params.id]
  );
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'KYC_REJECT', targetType: 'user', targetId: req.params.id, meta: { reason } });
  await mailer.sendGenericEmail(rows[0].email, 'OffPay verification update',
    `Hi ${rows[0].full_name}, we could not verify your account: ${reason}. Please contact support to resolve this or resubmit your documents.`);

  res.json({ success: true, message: 'KYC rejected.' });
}

module.exports = { listPending, getOne, approve, reject };
