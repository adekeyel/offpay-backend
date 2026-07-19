const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');
const { decrypt, maskLast4 } = require('../utils/encryption');
const walletService = require('../services/wallet.service');

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
            u.address, u.tier_upgrade_status, u.created_at,
            w.wallet_id, w.virtual_account, w.virtual_bank, w.balance, w.is_frozen
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  // Masked here deliberately — this endpoint is shared by support, finance,
  // operations, fraud, and recovery, none of whom need the full BVN/NIN for
  // their work. Compliance sees the full, unmasked numbers on the dedicated
  // KYC review screens instead (adminKyc.controller.js), where manual
  // identity verification actually happens.
  const { bvn_encrypted, nin_encrypted, ...userDetail } = rows[0];
  userDetail.bvn = maskLast4(decrypt(bvn_encrypted));
  userDetail.nin = nin_encrypted ? maskLast4(decrypt(nin_encrypted)) : null;

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

/** Reverses a previous block/freeze/suspend/delete action, restoring prior state. */
async function reverseAction(req, res) {
  const { rows } = await query('SELECT * FROM account_actions WHERE id = $1', [req.params.actionId]);
  if (!rows.length) throw ApiError.notFound('Action not found.');
  const actionRecord = rows[0];
  if (actionRecord.reversed) throw ApiError.conflict('This action has already been reversed.');
  if (actionRecord.action === 'reverse') throw ApiError.badRequest('Cannot reverse a reversal — this is a permanent ledger correction.');

  await withTransaction(async (client) => {
    if (actionRecord.action === 'freeze') {
      await client.query('UPDATE wallets SET is_frozen = false WHERE user_id = $1', [actionRecord.user_id]);
    } else {
      await client.query(`UPDATE users SET status = 'active' WHERE id = $1`, [actionRecord.user_id]);
    }
    await client.query('UPDATE account_actions SET reversed = true, reversed_by = $1, reversed_at = now() WHERE id = $2', [req.admin.id, actionRecord.id]);
  });

  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'ACCOUNT_ACTION_REVERSED', targetType: 'account_action', targetId: actionRecord.id });
  res.json({ success: true, message: 'Account restored to its previous state.' });
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

module.exports = { listUsers, getUserDetail, applyAction, reverseAction, reverseTransaction };
