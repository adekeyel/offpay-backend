const walletService = require('../services/wallet.service');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');

async function getSummary(req, res) {
  const summary = await walletService.getWalletSummary(req.user.id);
  res.json({ success: true, data: summary });
}

/** Issue a fresh offline spending token — call this while the app has connectivity. */
async function issueOfflineToken(req, res) {
  const result = await walletService.issueOfflineToken(req.user.id, null);
  res.json({
    success: true,
    message: `Offline mode ready. You can spend up to ₦${result.offlineLimit.toLocaleString()} (${result.availablePercent}% of your balance) while offline. ₦${result.lockedAmount.toLocaleString()} (${result.lockPercent}%) stays locked until you reconnect.`,
    data: result,
  });
}

/**
 * Called once the client regains connectivity. Sends the entire batch of
 * transactions that were queued purely on-device (IndexedDB) while offline,
 * along with the offline token that authorized them. The server re-validates
 * everything against the real balance snapshot before settling.
 */
async function syncOfflineBatch(req, res) {
  const { offlineToken, transactions } = req.body;
  if (!offlineToken) throw ApiError.badRequest('offlineToken is required.');
  if (!Array.isArray(transactions)) throw ApiError.badRequest('transactions must be an array.');

  if (transactions.length === 0) {
    return res.json({ success: true, message: 'Nothing to sync.', data: [] });
  }

  const results = await walletService.syncOfflineBatch(req.user.id, offlineToken, transactions);
  const settled = results.filter((r) => r.status === 'settled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;

  await auditService.logAction({
    actorType: 'user', actorId: req.user.id, action: 'OFFLINE_SYNC',
    meta: { settled, rejected }, ipAddress: req.ip,
  });

  res.json({
    success: true,
    message: `Sync complete: ${settled} transaction(s) settled${rejected ? `, ${rejected} rejected` : ''}.`,
    data: results,
  });
}

/** Look up a wallet by its Wallet ID or account number, to confirm the recipient before sending. */
async function resolveWallet(req, res) {
  const { walletId, accountNumber } = req.query;
  if (!walletId && !accountNumber) throw ApiError.badRequest('Provide walletId or accountNumber.');

  const walletService2 = require('../services/wallet.service');
  const wallet = walletId
    ? await walletService2.getWalletByWalletId(walletId)
    : await walletService2.getWalletByAccountNumber(accountNumber);

  const { query } = require('../config/db');
  const { rows } = await query('SELECT full_name FROM users WHERE id = $1', [wallet.user_id]);

  res.json({
    success: true,
    data: { walletId: wallet.wallet_id, accountNumber: wallet.virtual_account, accountName: rows[0]?.full_name },
  });
}

module.exports = { getSummary, issueOfflineToken, syncOfflineBatch, resolveWallet };
