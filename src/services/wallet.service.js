const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { query, withTransaction } = require('../config/db');
const { generateTxnReference } = require('../utils/idGenerators');
const ApiError = require('../utils/ApiError');
const tokenService = require('./token.service');

/**
 * ---------------------------------------------------------------------------
 * OFFLINE LOCK MODEL
 * ---------------------------------------------------------------------------
 * OffPay cannot magically talk to a server with zero connectivity anywhere
 * in the chain — true device-to-device money movement without any network
 * hop isn't technically or regulatorily sound (it opens the door to double-
 * spending). Instead we implement "offline-first" spending with a hard cap:
 *
 * 1. While the app has connectivity, the client periodically requests an
 *    "offline token" (see issueOfflineToken). This is a signed JWT containing
 *    a snapshot of the wallet balance and a spending ceiling equal to
 *    OFFLINE_AVAILABLE_PERCENT (default 40%) of that snapshot. The remaining
 *    60% is the "locked" portion and cannot be spent under any offline token.
 *
 * 2. When the device loses connectivity, the frontend uses the cached token
 *    to authorize wallet-to-wallet payments locally (by wallet ID), queuing
 *    them in local storage/IndexedDB. The client itself enforces the 40% cap
 *    so the user gets instant feedback — but this is a UX convenience only.
 *
 * 3. The server is the source of truth: every offline transaction is
 *    re-validated against the *same* balance snapshot when the device
 *    reconnects (syncOfflineQueue). If cumulative offline spend for that
 *    token would exceed the 40% ceiling (e.g. two devices, or the wallet
 *    was also debited online in the meantime), excess transactions are
 *    rejected and flagged for the user, never silently overdrawn.
 * ---------------------------------------------------------------------------
 */

async function getWalletByUserId(userId) {
  const { rows } = await query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  if (!rows.length) throw ApiError.notFound('Wallet not found.');
  return rows[0];
}

async function getWalletByWalletId(walletId) {
  const { rows } = await query('SELECT * FROM wallets WHERE wallet_id = $1', [walletId]);
  if (!rows.length) throw ApiError.notFound('No OffPay wallet found with that Wallet ID.');
  return rows[0];
}

async function getWalletByAccountNumber(accountNumber) {
  const { rows } = await query('SELECT * FROM wallets WHERE virtual_account = $1', [accountNumber]);
  if (!rows.length) throw ApiError.notFound('No OffPay account found with that account number.');
  return rows[0];
}

/** Issues a signed offline spending token while the device is online. */
async function issueOfflineToken(userId, sessionId) {
  const wallet = await getWalletByUserId(userId);
  if (wallet.is_frozen) throw ApiError.forbidden('This wallet is frozen and cannot generate an offline token.');

  // Only one active token per wallet at a time — otherwise a sender could
  // rack up two separate 40%-of-snapshot allowances by requesting a token
  // twice, effectively doubling their real offline spending cap.
  await query(`UPDATE offline_tokens SET status = 'revoked' WHERE wallet_id = $1 AND status = 'active'`, [wallet.id]);

  const balance = parseFloat(wallet.balance);
  const offlineLimit = Math.round(balance * (env.offline.availablePercent / 100) * 100) / 100;
  const lockedAmount = Math.round((balance - offlineLimit) * 100) / 100;
  const expiresAt = new Date(Date.now() + env.offline.ttlHours * 60 * 60 * 1000);

  const payload = {
    walletId: wallet.id,
    walletPublicId: wallet.wallet_id,
    balanceSnapshot: balance,
    offlineLimit,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const signedToken = jwt.sign(payload, env.offline.tokenSecret);
  const tokenHash = tokenService.hashToken(signedToken);

  const { rows } = await query(
    `INSERT INTO offline_tokens (wallet_id, session_id, token_hash, balance_snapshot, offline_limit, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [wallet.id, sessionId || null, tokenHash, balance, offlineLimit, expiresAt]
  );

  return {
    offlineTokenId: rows[0].id,
    token: signedToken,
    balanceSnapshot: balance,
    offlineLimit,
    lockedAmount,
    lockPercent: env.offline.lockPercent,
    availablePercent: env.offline.availablePercent,
    expiresAt,
  };
}

/** Returns the current online-mode wallet summary, including what a fresh offline token would look like. */
async function getWalletSummary(userId) {
  const wallet = await getWalletByUserId(userId);
  const balance = parseFloat(wallet.balance);
  const offlineLimit = Math.round(balance * (env.offline.availablePercent / 100) * 100) / 100;
  const lockedIfOffline = Math.round((balance - offlineLimit) * 100) / 100;

  const { rows: activeTokens } = await query(
    `SELECT * FROM offline_tokens WHERE wallet_id = $1 AND status = 'active' AND expires_at > now() ORDER BY issued_at DESC LIMIT 1`,
    [wallet.id]
  );

  // Incoming offline-transfer vouchers the receiver has been notified of
  // (or the sender is mid-sync on) that haven't settled yet — visible, but
  // deliberately excluded from `balance` itself until confirmed. See
  // offlineVoucher.controller.js for the full flow this supports.
  const { rows: pendingRows } = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM offline_vouchers WHERE receiver_id = $1 AND status = 'pending_sync'`,
    [userId]
  );
  const pending = parseFloat(pendingRows[0].total);

  return {
    walletId: wallet.wallet_id,
    accountNumber: wallet.virtual_account,
    bankName: wallet.virtual_bank,
    balance,
    confirmed: balance,
    pending,
    totalIncludingPending: Math.round((balance + pending) * 100) / 100,
    currency: wallet.currency,
    isFrozen: wallet.is_frozen,
    offlineLock: {
      lockPercent: env.offline.lockPercent,
      availablePercent: env.offline.availablePercent,
      wouldLock: lockedIfOffline,
      wouldBeAvailable: offlineLimit,
    },
    activeOfflineToken: activeTokens[0]
      ? {
          issuedAt: activeTokens[0].issued_at,
          expiresAt: activeTokens[0].expires_at,
          offlineLimit: parseFloat(activeTokens[0].offline_limit),
          spentOffline: parseFloat(activeTokens[0].spent_offline),
          remaining: Math.round((parseFloat(activeTokens[0].offline_limit) - parseFloat(activeTokens[0].spent_offline)) * 100) / 100,
        }
      : null,
  };
}

/** Atomically debits a wallet, recording a ledger entry. Throws if insufficient funds. */
async function debitWallet(client, { walletId, amount, fee = 0, type, provider, providerReference, counterparty, narration, meta, offlineQueueId, status = 'success' }) {
  const { rows: walletRows } = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  if (!walletRows.length) throw ApiError.notFound('Wallet not found.');
  const wallet = walletRows[0];
  if (wallet.is_frozen) throw ApiError.forbidden('This wallet is frozen.');

  const totalDebit = parseFloat(amount) + parseFloat(fee);
  const balanceBefore = parseFloat(wallet.balance);
  if (balanceBefore < totalDebit) throw ApiError.badRequest('Insufficient balance.');

  const balanceAfter = Math.round((balanceBefore - totalDebit) * 100) / 100;
  await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2', [balanceAfter, walletId]);

  const reference = generateTxnReference();
  const { rows: txnRows } = await client.query(
    `INSERT INTO transactions
      (reference, wallet_id, type, direction, amount, fee, balance_before, balance_after, status, provider, provider_reference,
       counterparty_name, counterparty_bank, counterparty_number, narration, meta, offline_queue_id)
     VALUES ($1,$2,$3,'debit',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [reference, walletId, type, amount, fee, balanceBefore, balanceAfter, status, provider || 'internal', providerReference || null,
      counterparty?.name || null, counterparty?.bank || null, counterparty?.number || null, narration || null, meta || {}, offlineQueueId || null]
  );

  return txnRows[0];
}

/**
 * Reverses a previously-debited transaction that failed after the debit was
 * recorded (e.g. a bank payout the provider rejected after we'd already
 * deducted the money). Credits the amount + fee back and links the two rows
 * via reversed_txn_id so the ledger shows the full story, not just a mystery
 * refund.
 */
async function reverseDebit(client, { originalTxn, reason }) {
  const { rows: walletRows } = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [originalTxn.wallet_id]);
  const wallet = walletRows[0];
  const refundAmount = parseFloat(originalTxn.amount) + parseFloat(originalTxn.fee);
  const balanceBefore = parseFloat(wallet.balance);
  const balanceAfter = Math.round((balanceBefore + refundAmount) * 100) / 100;
  await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2', [balanceAfter, wallet.id]);

  await client.query(`UPDATE transactions SET status = 'failed', meta = meta || $1 WHERE id = $2`, [JSON.stringify({ failureReason: reason }), originalTxn.id]);

  const reference = generateTxnReference();
  const { rows } = await client.query(
    `INSERT INTO transactions
      (reference, wallet_id, type, direction, amount, fee, balance_before, balance_after, status, provider, narration, reversed_txn_id)
     VALUES ($1,$2,$3,'credit',$4,0,$5,$6,'reversed',$7,$8,$9)
     RETURNING *`,
    [reference, wallet.id, originalTxn.type, refundAmount, balanceBefore, balanceAfter, originalTxn.provider, `Refund: ${reason}`, originalTxn.id]
  );
  return rows[0];
}

/** Atomically credits a wallet, recording a ledger entry. */
async function creditWallet(client, { walletId, amount, type, provider, providerReference, counterparty, narration, meta, offlineQueueId }) {
  const { rows: walletRows } = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
  if (!walletRows.length) throw ApiError.notFound('Wallet not found.');
  const wallet = walletRows[0];

  const balanceBefore = parseFloat(wallet.balance);
  const balanceAfter = Math.round((balanceBefore + parseFloat(amount)) * 100) / 100;
  await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2', [balanceAfter, walletId]);

  const reference = generateTxnReference();
  const { rows: txnRows } = await client.query(
    `INSERT INTO transactions
      (reference, wallet_id, type, direction, amount, fee, balance_before, balance_after, status, provider, provider_reference,
       counterparty_name, counterparty_bank, counterparty_number, narration, meta, offline_queue_id)
     VALUES ($1,$2,$3,'credit',$4,0,$5,$6,'success',$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [reference, walletId, type, amount, balanceBefore, balanceAfter, provider || 'internal', providerReference || null,
      counterparty?.name || null, counterparty?.bank || null, counterparty?.number || null, narration || null, meta || {}, offlineQueueId || null]
  );

  return txnRows[0];
}

/**
 * Settles a batch of wallet-to-wallet transfers that were created and queued
 * entirely on-device while offline (see lib/offlineDb.js on the frontend —
 * a genuinely offline device cannot reach this endpoint until it reconnects,
 * so there is deliberately no "register while offline" server call; the
 * device is the only thing enforcing the cap in real time, and this endpoint
 * re-validates everything against the source-of-truth balance snapshot the
 * instant connectivity returns).
 *
 * Transactions are processed in the order they were created on-device.
 * Each one is checked against the remaining offline allowance; anything that
 * would exceed the 40%-of-snapshot cap is rejected individually rather than
 * failing the whole batch, so the user only loses the specific overflowing
 * payment, not everything they did while offline.
 */
async function syncOfflineBatch(userId, signedOfflineToken, transactions) {
  let payload;
  try {
    payload = jwt.verify(signedOfflineToken, env.offline.tokenSecret);
  } catch {
    throw ApiError.unauthorized('Your offline session has expired. Reconnect and prepare offline mode again before retrying these payments.');
  }

  const wallet = await getWalletByUserId(userId);
  if (payload.walletId !== wallet.id) throw ApiError.forbidden('This offline token does not belong to your wallet.');

  const tokenHash = tokenService.hashToken(signedOfflineToken);
  const { rows: tokenRows } = await query(`SELECT * FROM offline_tokens WHERE token_hash = $1`, [tokenHash]);
  if (!tokenRows.length) throw ApiError.unauthorized('Offline authorization not recognized.');
  const offlineToken = tokenRows[0];
  if (offlineToken.status === 'synced') throw ApiError.conflict('This offline session has already been synced.');

  const feeService = require('./fee.service');
  const results = [];
  let runningSpend = parseFloat(offlineToken.spent_offline);
  const cap = parseFloat(offlineToken.offline_limit);

  const sorted = [...transactions].sort((a, b) => new Date(a.deviceCreatedAt) - new Date(b.deviceCreatedAt));

  for (const item of sorted) {
    try {
      const amount = parseFloat(item.amount);
      const projected = Math.round((runningSpend + amount) * 100) / 100;
      if (projected > cap) {
        throw new Error(`Would exceed your offline limit of ₦${cap.toLocaleString()} (₦${(cap - runningSpend).toFixed(2)} remained available offline).`);
      }

      const recipient = await getWalletByWalletId(item.recipientWalletId);
      if (recipient.id === wallet.id) throw new Error('You cannot send money to your own wallet.');

      const settled = await withTransaction(async (client) => {
        const { rows: exists } = await client.query('SELECT id FROM offline_queue WHERE idempotency_key = $1', [item.idempotencyKey]);
        if (exists.length) return { alreadyProcessed: true };

        const fee = await feeService.calculateFee('transfer_offline', amount);
        const { rows: qRows } = await client.query(
          `INSERT INTO offline_queue (offline_token_id, sender_wallet_id, recipient_wallet_id, amount, narration, idempotency_key, device_created_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'settled') RETURNING id`,
          [offlineToken.id, wallet.id, recipient.id, amount, item.narration || null, item.idempotencyKey, item.deviceCreatedAt || new Date()]
        );
        const debitTxn = await debitWallet(client, {
          walletId: wallet.id, amount, fee, type: 'transfer_offline',
          narration: item.narration || 'Offline wallet transfer', offlineQueueId: qRows[0].id,
        });
        await creditWallet(client, {
          walletId: recipient.id, amount, type: 'transfer_offline',
          narration: item.narration || 'Offline wallet transfer received', offlineQueueId: qRows[0].id,
        });
        return { debitTxn };
      });

      if (!settled.alreadyProcessed) runningSpend = projected;
      results.push({ idempotencyKey: item.idempotencyKey, status: 'settled', reference: settled.debitTxn?.reference });
    } catch (err) {
      await query(
        `INSERT INTO offline_queue (offline_token_id, sender_wallet_id, recipient_wallet_id, amount, narration, idempotency_key, device_created_at, status, rejection_reason)
         SELECT $1, $2, w.id, $3, $4, $5, $6, 'rejected', $7 FROM wallets w WHERE w.wallet_id = $8
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [offlineToken.id, wallet.id, item.amount, item.narration || null, item.idempotencyKey, item.deviceCreatedAt || new Date(), err.message, item.recipientWalletId]
      ).catch(() => {});
      results.push({ idempotencyKey: item.idempotencyKey, status: 'rejected', reason: err.message });
    }
  }

  await query(`UPDATE offline_tokens SET spent_offline = $1, status = 'synced', synced_at = now() WHERE id = $2`, [runningSpend, offlineToken.id]);

  return results;
}

/**
 * Enforces the 40%-of-snapshot offline spending cap for a single voucher
 * being synced. Call this inside the same DB transaction as the debit, before
 * it, so the check and the spend-tracking update are atomic together — two
 * offline vouchers racing to sync at once can't both slip under the cap.
 *
 * Throws if there's no active (unexpired) offline token for this wallet at
 * all — under the documented design, a device should only be able to
 * authorize offline spending against a token it fetched while still online;
 * without one, there is nothing capping how much it could otherwise spend.
 */
async function reserveOfflineSpend(client, { walletId, amount }) {
  const { rows } = await client.query(
    `SELECT * FROM offline_tokens WHERE wallet_id = $1 AND status = 'active' AND expires_at > now() FOR UPDATE`,
    [walletId]
  );
  if (!rows.length) {
    throw ApiError.badRequest('No active offline session for this wallet. Connect and prepare offline mode (POST /wallet/offline-token) before sending money offline.');
  }
  const token = rows[0];
  const spent = parseFloat(token.spent_offline);
  const cap = parseFloat(token.offline_limit);
  const projected = Math.round((spent + parseFloat(amount)) * 100) / 100;

  if (projected > cap) {
    throw ApiError.badRequest(
      `This would exceed your offline spending limit of ₦${cap.toLocaleString()} (₦${(cap - spent).toFixed(2)} remains available offline). Reconnect to send more, or send a smaller amount.`
    );
  }

  await client.query(`UPDATE offline_tokens SET spent_offline = $1 WHERE id = $2`, [projected, token.id]);
  return token;
}

module.exports = {
  getWalletByUserId,
  getWalletByWalletId,
  getWalletByAccountNumber,
  issueOfflineToken,
  getWalletSummary,
  debitWallet,
  creditWallet,
  reverseDebit,
  reserveOfflineSpend,
  syncOfflineBatch,
};
