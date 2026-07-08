const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const auditService = require('../services/audit.service');

/** Search wallets by owner name, user id, email, or account number — used by the Wallet module. */
async function search(req, res) {
  const { q, limit = 25 } = req.query;
  if (!q) return res.json({ success: true, data: [] });

  const { rows } = await query(
    `SELECT u.id AS user_id, u.full_name, u.email, w.id AS wallet_id, w.wallet_id AS wallet_ref,
            w.virtual_account, w.balance, w.is_frozen
     FROM users u JOIN wallets w ON w.user_id = u.id
     WHERE u.full_name ILIKE $1 OR u.email ILIKE $1 OR u.id::text ILIKE $1
        OR w.wallet_id ILIKE $1 OR w.virtual_account ILIKE $1
     ORDER BY u.full_name LIMIT $2`,
    [`%${q}%`, limit]
  );
  res.json({ success: true, data: rows });
}

async function getWalletHistory(req, res) {
  const { rows: txns } = await query(
    `SELECT id, reference, type, direction, amount, fee, status, narration, created_at
     FROM transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.params.walletId]
  );
  res.json({ success: true, data: txns });
}

/** Super-admin-only manual credit or debit of a user's wallet, with a mandatory reason for the audit trail. */
async function adjust(req, res) {
  const { walletId } = req.params;
  const { direction, amount, reason } = req.body;
  if (!['credit', 'debit'].includes(direction)) throw ApiError.badRequest('direction must be "credit" or "debit".');
  if (!amount || amount <= 0) throw ApiError.badRequest('amount must be greater than zero.');
  if (!reason) throw ApiError.badRequest('A reason is required for a manual wallet adjustment.');

  const txn = await withTransaction(async (client) => {
    if (direction === 'credit') {
      return walletService.creditWallet(client, {
        walletId, amount, type: 'manual_adjustment', provider: 'internal',
        narration: `Manual credit by ${req.admin.fullName}: ${reason}`,
      });
    }
    return walletService.debitWallet(client, {
      walletId, amount, fee: 0, type: 'manual_adjustment', provider: 'internal',
      narration: `Manual debit by ${req.admin.fullName}: ${reason}`,
    });
  });

  await auditService.logAction({
    actorType: 'admin', actorId: req.admin.id,
    action: direction === 'credit' ? 'WALLET_MANUAL_CREDIT' : 'WALLET_MANUAL_DEBIT',
    targetType: 'wallet', targetId: walletId, meta: { amount, reason },
  });

  res.json({ success: true, message: `Wallet ${direction}ed successfully.`, data: txn });
}

module.exports = { search, getWalletHistory, adjust };
