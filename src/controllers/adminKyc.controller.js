const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const providerManager = require('../services/providers/providerManager');
const auditService = require('../services/audit.service');
const mailer = require('../services/mailer.service');
const { notifyUser } = require('../services/notify.service');
const { decrypt } = require('../utils/encryption');

async function listPending(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, bvn_encrypted, nin_encrypted, nin_slip_url, utility_bill_url,
            passport_url, kyc_status, created_at
     FROM users WHERE kyc_status = 'pending' ORDER BY created_at ASC`
  );
  // Compliance sees the FULL BVN/NIN here — that's the whole point of manual
  // verification (matching the submitted number against the ID photo). This
  // is deliberately different from the broader Accounts screen (other admin
  // roles), which only ever shows a masked BVN — see adminAccounts.controller.js.
  const revealed = rows.map(({ bvn_encrypted, nin_encrypted, ...rest }) => ({
    ...rest,
    bvn: decrypt(bvn_encrypted),
    nin: nin_encrypted ? decrypt(nin_encrypted) : null,
  }));
  res.json({ success: true, data: revealed });
}

async function getOne(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, bvn_encrypted, nin_encrypted, nin_slip_url, utility_bill_url,
            address, passport_url, status, kyc_status, kyc_notes, created_at
     FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  const { bvn_encrypted, nin_encrypted, ...rest } = rows[0];
  res.json({ success: true, data: { ...rest, bvn: decrypt(bvn_encrypted), nin: nin_encrypted ? decrypt(nin_encrypted) : null } });
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
      email: user.email, bvn: decrypt(user.bvn_encrypted), fullName: user.full_name, phone: user.phone, txRef: `OP-VA-${user.id}`,
    });
  } catch (err) {
    // No fake fallback — a placeholder "sandbox" account that isn't backed
    // by any real bank would let the user believe they can receive money
    // when they can't. Surface the real failure instead; the admin can
    // retry once the underlying provider issue (bad keys, provider outage,
    // etc.) is resolved. KYC status is NOT updated to 'approved' below in
    // this case, so retrying this same action is safe and idempotent.
    throw ApiError.badGateway(`KYC approval could not complete: virtual account creation failed (${err.message}). No provider succeeded — check your provider API keys on Railway.`);
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
      `INSERT INTO virtual_accounts (wallet_id, provider, provider_ref, account_number, bank_name, tx_ref) VALUES ($1,$2,$3,$4,$5,$6)`,
      [wallet.id, virtualAccount.providerUsed || virtualAccount.provider, virtualAccount.providerRef || null, virtualAccount.accountNumber, virtualAccount.bankName, virtualAccount.txRef || `OP-VA-${user.id}`]
    );
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'KYC_APPROVE', targetType: 'user', targetId: user.id });
  await mailer.sendGenericEmail(user.email, 'Your OffPay account is verified! 🎉',
    `Hi ${user.full_name}, your identity verification is complete. Your OffPay virtual account (${virtualAccount.accountNumber}, ${virtualAccount.bankName}) is now active — you can send and receive money right away.`);
  await notifyUser({
    userId: user.id, type: 'app', title: 'KYC verified 🎉',
    message: `Your identity verification is complete. Your OffPay account (${virtualAccount.accountNumber}, ${virtualAccount.bankName}) is now active.`,
  });

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
  await notifyUser({
    userId: req.params.id, type: 'app', title: 'KYC verification unsuccessful',
    message: `We could not verify your account: ${reason}. Please contact support or resubmit your documents.`,
  });

  res.json({ success: true, message: 'KYC rejected.' });
}

/**
 * Users at Tier 1+ awaiting review of a submitted tier upgrade. What's
 * populated depends on which tier they're moving to — kyc_tier tells you
 * which: kyc_tier=1 means this is a Tier 1->2 request (nin/nin_slip_url/
 * address are the relevant fields), kyc_tier=2 means Tier 2->3 (only
 * utility_bill_url is new; nin/address were already verified at Tier 2).
 */
async function listPendingTierUpgrades(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, kyc_tier, nin_encrypted, nin_slip_url, utility_bill_url, address, updated_at
     FROM users WHERE tier_upgrade_status = 'pending' ORDER BY updated_at ASC`
  );
  const revealed = rows.map(({ nin_encrypted, ...rest }) => ({
    ...rest,
    nin: nin_encrypted ? decrypt(nin_encrypted) : null,
  }));
  res.json({ success: true, data: revealed });
}

/**
 * Approves a pending tier upgrade, bumping kyc_tier by one level by default
 * (capped at 3 — see the tier definitions on users.kyc_tier in schema.sql).
 * Pass { tier } in the body to jump straight to a specific tier instead.
 */
async function approveTierUpgrade(req, res) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];
  if (user.tier_upgrade_status !== 'pending') throw ApiError.conflict('This user has no pending tier upgrade request.');

  const requestedTier = req.body.tier ? parseInt(req.body.tier, 10) : user.kyc_tier + 1;
  const newTier = Math.min(3, Math.max(user.kyc_tier, requestedTier || user.kyc_tier + 1));

  await query(
    `UPDATE users SET kyc_tier = $1, tier_upgrade_status = 'approved', tier_upgrade_notes = NULL,
            kyc_reviewed_by = $2, kyc_reviewed_at = now(), updated_at = now() WHERE id = $3`,
    [newTier, req.admin.id, user.id]
  );

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'TIER_UPGRADE_APPROVE',
    targetType: 'user', targetId: user.id, meta: { newTier },
  });
  await mailer.sendGenericEmail(user.email, 'Your OffPay verification tier has been upgraded',
    `Hi ${user.full_name}, your account has been upgraded to KYC Tier ${newTier}. Higher transaction and loan limits are now available.`);
  await notifyUser({
    userId: user.id, type: 'app', title: `Upgraded to Tier ${newTier}`,
    message: `Your account has been upgraded to KYC Tier ${newTier}. Higher transaction and loan limits are now available.`,
  });

  res.json({ success: true, message: `User upgraded to Tier ${newTier}.`, data: { kycTier: newTier } });
}

async function rejectTierUpgrade(req, res) {
  const { reason } = req.body;
  if (!reason) throw ApiError.badRequest('A rejection reason is required.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  if (rows[0].tier_upgrade_status !== 'pending') throw ApiError.conflict('This user has no pending tier upgrade request.');

  await query(
    `UPDATE users SET tier_upgrade_status = 'rejected', tier_upgrade_notes = $1,
            kyc_reviewed_by = $2, kyc_reviewed_at = now(), updated_at = now() WHERE id = $3`,
    [reason, req.admin.id, req.params.id]
  );
  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'TIER_UPGRADE_REJECT',
    targetType: 'user', targetId: req.params.id, meta: { reason },
  });
  await mailer.sendGenericEmail(rows[0].email, 'OffPay tier upgrade update',
    `Hi ${rows[0].full_name}, we could not approve your tier upgrade request: ${reason}. You can resubmit your documents at any time.`);
  await notifyUser({
    userId: req.params.id, type: 'app', title: 'Tier upgrade unsuccessful',
    message: `We could not approve your tier upgrade request: ${reason}. You can resubmit your documents at any time.`,
  });

  res.json({ success: true, message: 'Tier upgrade request rejected.' });
}

module.exports = { listPending, getOne, approve, reject, listPendingTierUpgrades, approveTierUpgrade, rejectTierUpgrade };
