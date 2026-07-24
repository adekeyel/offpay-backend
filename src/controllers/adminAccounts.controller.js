const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');
const { decrypt, maskLast4 } = require('../utils/encryption');
const walletService = require('../services/wallet.service');
const otpService = require('../services/otp.service');
const mailer = require('../services/mailer.service');
const { notifyUser } = require('../services/notify.service');

const FILTER_MAP = {
  all: null,
  active: `u.status = 'active'`,
  frozen: `u.status = 'frozen'`,
  suspended: `u.status = 'suspended'`,
  closed: `u.status = 'closed'`,
  signup: `u.status = 'pending_kyc'`,
  signup_rejected: `u.kyc_status = 'rejected'`,
  kyc_pending: `u.kyc_status = 'pending'`,
  kyc_approved: `u.kyc_status = 'approved'`,
};

async function listUsers(req, res) {
  const { search, filter = 'all', limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];

  if (filter && filter !== 'all') {
    if (!FILTER_MAP[filter]) throw ApiError.badRequest(`Unknown filter: ${filter}`);
    conditions.push(FILTER_MAP[filter]);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.kyc_status, u.kyc_tier, u.created_at,
            w.wallet_id, w.balance
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id
     ${where}
     ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const { rows: countRows } = await query(`SELECT COUNT(*) FROM users u ${where}`, params.slice(0, params.length - 2));
  res.json({ success: true, data: rows, meta: { total: parseInt(countRows[0].count, 10) } });
}

async function getUserDetail(req, res) {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.bvn_encrypted, u.nin_encrypted, u.status, u.kyc_status, u.kyc_tier,
            u.address, u.tier_upgrade_status, u.tier_upgrade_notes, u.date_of_birth, u.sex,
            u.passport_url, u.nin_slip_url, u.utility_bill_url, u.created_at,
            w.wallet_id, w.virtual_account, w.virtual_bank, w.balance, w.is_frozen
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  // Full docs (passport/NIN slip/utility bill), date of birth, and sex are
  // visible to every staff role that can reach this screen (support,
  // compliance, finance, operations, fraud, recovery, admin) — the whole
  // point is letting whoever picks up a support conversation confirm who
  // they're talking to without having to ask the user to re-send documents.
  //
  // BVN/NIN stay masked for everyone EXCEPT the 'admin' role, which sees
  // them in full here. This mirrors the dedicated KYC review screens
  // (adminKyc.controller.js), where compliance also sees the full number,
  // but ONLY there — this general Accounts screen keeps it masked for every
  // role other than admin, per policy.
  const { bvn_encrypted, nin_encrypted, ...userDetail } = rows[0];
  const canSeeFullPii = req.admin.role === 'admin';
  const decryptedBvn = decrypt(bvn_encrypted);
  const decryptedNin = nin_encrypted ? decrypt(nin_encrypted) : null;
  userDetail.bvn = canSeeFullPii ? decryptedBvn : maskLast4(decryptedBvn);
  userDetail.nin = decryptedNin ? (canSeeFullPii ? decryptedNin : maskLast4(decryptedNin)) : null;

  const { rows: actions } = await query(
    `SELECT aa.*, a.full_name as performed_by_name FROM account_actions aa
     JOIN admin_users a ON a.id = aa.performed_by WHERE aa.user_id = $1 ORDER BY aa.created_at DESC`,
    [req.params.id]
  );

  res.json({ success: true, data: { ...userDetail, accountActions: actions } });
}

const ACTION_STATUS_MAP = { block: 'blocked', freeze: 'frozen', suspend: 'suspended', close: 'closed', delete: 'deleted' };

async function applyAction(req, res) {
  const { action } = req.params;
  const { reason } = req.body;
  if (!['block', 'freeze', 'suspend', 'close', 'delete'].includes(action)) throw ApiError.badRequest('Invalid action.');
  if (!reason) throw ApiError.badRequest('A reason is required for this action.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');

  await withTransaction(async (client) => {
    if (action === 'freeze') {
      await client.query('UPDATE wallets SET is_frozen = true WHERE user_id = $1', [req.params.id]);
    } else {
      await client.query('UPDATE users SET status = $1 WHERE id = $2', [ACTION_STATUS_MAP[action], req.params.id]);
    }
    await client.query(
      `INSERT INTO account_actions (user_id, action, reason, performed_by) VALUES ($1,$2,$3,$4)`,
      [req.params.id, action, reason, req.admin.id]
    );
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: `ACCOUNT_${action.toUpperCase()}`, targetType: 'user', targetId: req.params.id, meta: { reason } });
  res.json({ success: true, message: `Account ${action}ed successfully.` });
}

/**
 * Reverses a previous block/freeze/suspend/delete action, restoring prior state.
 * For 'delete', pass { force: true } in the body to restore the account even
 * though its email or BVN is now also in use by a newer account (both are
 * allowed to collide by design — see auth.controller.js register() — so an
 * admin can deliberately restore into that state). A genuine phone conflict
 * is never bypassed, since phone stays a hard one-account rule.
 */
async function reverseAction(req, res) {
  const { force } = req.body || {};
  const { rows } = await query('SELECT * FROM account_actions WHERE id = $1', [req.params.actionId]);
  if (!rows.length) throw ApiError.notFound('Action not found.');
  const actionRecord = rows[0];
  if (actionRecord.reversed) throw ApiError.conflict('This action has already been reversed.');
  if (actionRecord.action === 'reverse') throw ApiError.badRequest('Cannot reverse a reversal — this is a permanent ledger correction.');

  let restoredWithConflict = false;
  await withTransaction(async (client) => {
    if (actionRecord.action === 'freeze') {
      await client.query('UPDATE wallets SET is_frozen = false WHERE user_id = $1', [actionRecord.user_id]);
    } else {
      if (actionRecord.action === 'delete') {
        // Someone may have registered a brand-new account reusing this
        // person's email/phone/BVN since the account was deleted (that's
        // the whole point of freeing them up) — restoring the old deleted
        // row to 'active' would then land it alongside that newer account.
        const { rows: userRows } = await client.query('SELECT email, phone, bvn_hash FROM users WHERE id = $1', [actionRecord.user_id]);
        const { email, phone, bvn_hash } = userRows[0];

        const { rows: phoneConflicts } = await client.query(
          `SELECT id FROM users WHERE phone = $1 AND status != 'deleted' AND id != $2`,
          [phone, actionRecord.user_id]
        );
        if (phoneConflicts.length) {
          throw ApiError.conflict('Cannot restore this account — its phone number is already in use by a newer account.');
        }

        const { rows: identityConflicts } = await client.query(
          `SELECT id FROM users WHERE (email = $1 OR bvn_hash = $2) AND status != 'deleted' AND id != $3`,
          [email, bvn_hash, actionRecord.user_id]
        );
        if (identityConflicts.length) {
          if (!force) {
            throw ApiError.conflict('This account\'s email or BVN is already in use by another account. Pass force to restore it anyway.');
          }
          restoredWithConflict = true;
        }
      }
      await client.query(`UPDATE users SET status = 'active' WHERE id = $1`, [actionRecord.user_id]);
    }
    await client.query('UPDATE account_actions SET reversed = true, reversed_by = $1, reversed_at = now() WHERE id = $2', [req.admin.id, actionRecord.id]);
  });

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'ACCOUNT_ACTION_REVERSED',
    targetType: 'account_action', targetId: actionRecord.id, meta: { restoredWithConflict },
  });
  res.json({
    success: true,
    message: restoredWithConflict
      ? 'Account restored despite a matching email/BVN on another account.'
      : 'Account restored to its previous state.',
  });
}

/** Admin-initiated email change. Blocked only if the new email is already used by a DIFFERENT identity (different BVN) — reusing it under the same BVN follows the same allowance as registration. */
async function updateEmail(req, res) {
  const { email, reason } = req.body;
  if (!email) throw ApiError.badRequest('email is required.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw ApiError.badRequest('Enter a valid email address.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];

  const { rows: matches } = await query(
    `SELECT id, bvn_hash FROM users WHERE email = $1 AND status != 'deleted' AND id != $2`,
    [email, user.id]
  );
  if (matches.some((u) => u.bvn_hash !== user.bvn_hash)) {
    throw ApiError.conflict('This email address is already in use by a different account.');
  }

  const oldEmail = user.email;
  await query('UPDATE users SET email = $1, updated_at = now() WHERE id = $2', [email, user.id]);
  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id, action: 'ADMIN_EMAIL_CHANGE',
    targetType: 'user', targetId: user.id, meta: { from: oldEmail, to: email, reason: reason || null },
  });
  res.json({ success: true, message: 'Email address updated.', data: { email } });
}

/** Clears lockouts/failed-login state and revokes every session, forcing a fresh login everywhere. */
async function resetAccount(req, res) {
  const { reason } = req.body;
  const { rows } = await query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');

  await withTransaction(async (client) => {
    await client.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
    await client.query('UPDATE sessions SET revoked = true, is_online = false WHERE user_id = $1 AND revoked = false', [req.params.id]);
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'ADMIN_ACCOUNT_RESET', targetType: 'user', targetId: req.params.id, meta: { reason: reason || null } });
  res.json({ success: true, message: 'Account reset — lockouts cleared and every session signed out.' });
}

/** Marks the account's email as unverified again and sends a fresh verification OTP. */
async function resetEmail(req, res) {
  const { reason } = req.body;
  const { rows } = await query('SELECT id, email, full_name FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];

  await query('UPDATE users SET is_email_verified = false, updated_at = now() WHERE id = $1', [user.id]);
  await otpService.issueOtp({ userId: user.id, destination: user.email, channel: 'email', purpose: 'register' });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'ADMIN_EMAIL_RESET', targetType: 'user', targetId: user.id, meta: { reason: reason || null } });
  res.json({ success: true, message: 'Email marked unverified and a new verification code was sent.' });
}

/** Clears a user's stored address (e.g. to let them resubmit during a tier upgrade). */
async function clearAddress(req, res) {
  const { reason } = req.body;
  const { rows } = await query('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');

  await query('UPDATE users SET address = NULL, address_updated_at = NULL, updated_at = now() WHERE id = $1', [req.params.id]);
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'ADMIN_ADDRESS_CLEAR', targetType: 'user', targetId: req.params.id, meta: { reason: reason || null } });
  res.json({ success: true, message: 'Address cleared.' });
}

/**
 * Lowers a user's KYC tier by one (or to a specific { tier } passed in the
 * body), the reverse of adminKyc.controller.js's approveTierUpgrade. Floors
 * at Tier 1 — every account keeps at least the signup-default level of
 * verification.
 */
async function downgradeTier(req, res) {
  const { reason, tier } = req.body;
  if (!reason) throw ApiError.badRequest('A reason is required to downgrade a user\'s tier.');

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];

  const requestedTier = tier ? parseInt(tier, 10) : user.kyc_tier - 1;
  const newTier = Math.max(1, Math.min(user.kyc_tier, requestedTier || user.kyc_tier - 1));
  if (newTier >= user.kyc_tier) throw ApiError.badRequest('The new tier must be lower than the user\'s current tier.');

  await query(
    `UPDATE users SET kyc_tier = $1, tier_upgrade_status = NULL, tier_upgrade_notes = NULL, updated_at = now() WHERE id = $2`,
    [newTier, user.id]
  );

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'ADMIN_TIER_DOWNGRADE', targetType: 'user', targetId: user.id, meta: { from: user.kyc_tier, to: newTier, reason } });
  await mailer.sendGenericEmail(user.email, 'Your OffPay verification tier has changed',
    `Hi ${user.full_name}, your account's KYC tier has been changed to Tier ${newTier}. Contact support if you have questions.`);
  await notifyUser({
    userId: user.id, type: 'app', title: `Moved to Tier ${newTier}`,
    message: `Your account's KYC tier has been changed to Tier ${newTier}.`,
  });

  res.json({ success: true, message: `User downgraded to Tier ${newTier}.`, data: { kycTier: newTier } });
}

/** Reverses a specific transaction (refunds the sender, debits the recipient if funds are still available). Finance/admin only. */
async function reverseTransaction(req, res) {
  const { reason } = req.body;
  if (!reason) throw ApiError.badRequest('A reason is required to reverse a transaction.');

  const { rows } = await query('SELECT * FROM transactions WHERE id = $1', [req.params.txnId]);
  if (!rows.length) throw ApiError.notFound('Transaction not found.');
  const txn = rows[0];
  if (txn.status === 'reversed') throw ApiError.conflict('This transaction has already been reversed.');
  if (!['success'].includes(txn.status)) throw ApiError.badRequest('Only successful transactions can be reversed.');

  const reversal = await withTransaction(async (client) => {
    let entry;
    if (txn.direction === 'debit') {
      entry = await walletService.creditWallet(client, {
        walletId: txn.wallet_id, amount: parseFloat(txn.amount) + parseFloat(txn.fee), type: 'reversal',
        narration: `Reversal of ${txn.reference}: ${reason}`,
      });
    } else {
      entry = await walletService.debitWallet(client, {
        walletId: txn.wallet_id, amount: txn.amount, fee: 0, type: 'reversal',
        narration: `Reversal of ${txn.reference}: ${reason}`,
      });
    }
    await client.query(`UPDATE transactions SET status = 'reversed', reversed_txn_id = $1 WHERE id = $2`, [entry.id, txn.id]);
    await client.query(
      `INSERT INTO account_actions (user_id, action, reason, performed_by, target_txn_id)
       SELECT user_id, 'reverse', $1, $2, $3 FROM wallets WHERE id = $4`,
      [reason, req.admin.id, txn.id, txn.wallet_id]
    );
    return entry;
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'TRANSACTION_REVERSE', targetType: 'transaction', targetId: txn.id, meta: { reason } });
  res.json({ success: true, message: 'Transaction reversed.', data: { newReference: reversal.reference } });
}

module.exports = {
  listUsers, getUserDetail, applyAction, reverseAction, reverseTransaction,
  updateEmail, resetAccount, resetEmail, clearAddress, downgradeTier,
};
