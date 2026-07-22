const walletService = require('../services/wallet.service');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');
const feeService = require('../services/fee.service');
const tierLimitService = require('../services/tierLimit.service');
const providerManager = require('../services/providers/providerManager');
const { requireValidPin } = require('../utils/verifyPin');
const securityService = require('../services/security.service');
const { query, withTransaction } = require('../config/db');
const { generateTxnReference } = require('../utils/idGenerators');

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
  const { rows } = await query('SELECT id, full_name FROM users WHERE id = $1', [wallet.user_id]);
  if (!rows.length) throw ApiError.notFound('No account found for this wallet ID.');

  // Don't let a user "resolve" their own wallet as a transfer target — same
  // guard the offline QR flow already has client-side (self-transfer isn't
  // a real transfer), just enforced here too since this path skips that check.
  if (wallet.user_id === req.user.id) throw ApiError.badRequest('You cannot send money to yourself.');

  res.json({
    success: true,
    data: { userId: rows[0].id, walletId: wallet.wallet_id, accountNumber: wallet.virtual_account, accountName: rows[0].full_name },
  });
}

/**
 * Confirms the account holder's name for an external bank account before the
 * user commits to sending money — standard practice so a mistyped account
 * number doesn't silently send funds to the wrong person. Read-only, no PIN
 * required, and doesn't touch the wallet at all.
 */
async function resolveExternalAccount(req, res) {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode) throw ApiError.badRequest('accountNumber and bankCode are required.');

  const result = await providerManager.resolveAccount({ accountNumber, bankCode });
  res.json({ success: true, data: { accountName: result.accountName, accountNumber: result.accountNumber } });
}

/**
 * Sends money from the user's wallet to an external bank account.
 *
 * Bank payouts are NOT instant like in-app transfers — Flutterwave/Paystack
 * process them asynchronously and confirm success/failure via webhook. So
 * this endpoint:
 *   1. Debits the wallet immediately with status 'pending' (money leaves the
 *      spendable balance right away — it should not be double-spendable
 *      while the payout is in flight).
 *   2. Calls the provider to actually initiate the transfer.
 *   3. If the provider call itself fails synchronously (bad account, provider
 *      down, etc.), immediately reverses the debit and tells the user.
 *   4. If the provider accepts the transfer, it stays 'pending' until
 *      POST /api/webhooks/flutterwave (or paystack) delivers the final
 *      transfer.completed event — see webhook.routes.js, which reconciles
 *      it to 'success' or reverses it on failure.
 */
async function transferToBank(req, res) {
  const { accountNumber, bankCode, bankName, amount, narration, pin, otpCode } = req.body;
  if (!accountNumber || !bankCode || !amount) throw ApiError.badRequest('accountNumber, bankCode, and amount are required.');
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) throw ApiError.badRequest('Enter a valid amount.');

  await requireValidPin(req.user.id, pin);
  // Online-only enforcement — see security.service.js enforceTransferOtp()
  // for why this is never called for offline-queued transfers.
  await securityService.enforceTransferOtp({ userId: req.user.id, email: req.user.email, amount: amt, otpCode });

  const wallet = await walletService.getWalletByUserId(req.user.id);
  await tierLimitService.enforceOutgoingLimit({ userId: req.user.id, walletId: wallet.id, amount: amt });
  const fee = await feeService.calculateFee('withdrawal_interbank', amt);

  // Debit first, inside its own transaction, so the money is locked before
  // we ever call out to the provider — this is the same "debit-then-confirm"
  // pattern used for offline vouchers, adapted for an async provider instead
  // of an async device.
  const debitTxn = await withTransaction(async (client) => {
    return walletService.debitWallet(client, {
      walletId: wallet.id, amount: amt, fee, type: 'withdrawal_external', provider: 'pending',
      counterparty: { name: null, bank: bankName || bankCode, number: accountNumber },
      narration: narration || 'Bank transfer', status: 'pending',
    });
  });

  try {
    const reference = generateTxnReference();
    const transfer = await providerManager.initiateTransfer({
      amount: amt, bankCode, accountNumber, narration: narration || 'OffPay transfer', reference,
    });

    await query(
      `UPDATE transactions SET provider = $1, provider_reference = $2, meta = meta || $3 WHERE id = $4`,
      [transfer.providerUsed, transfer.providerRef, JSON.stringify({ payoutReference: reference, providerStatus: transfer.status }), debitTxn.id]
    );

    await auditService.logAction({
      actorType: 'user', actorId: req.user.id, action: 'BANK_TRANSFER_INITIATED',
      targetType: 'transaction', targetId: debitTxn.id, meta: { amount: amt, bankCode, accountNumber, provider: transfer.providerUsed }, ipAddress: req.ip,
    });

    res.status(202).json({
      success: true,
      message: 'Transfer initiated. This usually completes within a few minutes.',
      data: { ...debitTxn, status: 'pending', provider: transfer.providerUsed, provider_reference: transfer.providerRef },
    });
  } catch (err) {
    // Provider rejected the transfer outright (bad account, insufficient
    // provider float, provider outage, etc.) — refund immediately rather
    // than leaving the user's money stuck in limbo.
    await withTransaction(async (client) => {
      await walletService.reverseDebit(client, { originalTxn: debitTxn, reason: err.message || 'Transfer could not be initiated.' });
    });
    throw ApiError.badGateway(`Transfer failed: ${err.message}. Your money has been refunded.`);
  }
}

module.exports = { getSummary, issueOfflineToken, syncOfflineBatch, resolveWallet, resolveExternalAccount, transferToBank };
