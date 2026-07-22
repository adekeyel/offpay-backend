const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { query, withTransaction } = require('../config/db');
const walletService = require('../services/wallet.service');
const feeService = require('../services/fee.service');
const tierLimitService = require('../services/tierLimit.service');
const logger = require('../utils/logger');
const env = require('../config/env');

/**
 * Production webhook endpoints for Flutterwave and Paystack. Point your
 * provider dashboard's webhook URL at:
 *   https://<your-domain>/api/webhooks/flutterwave
 *   https://<your-domain>/api/webhooks/paystack
 *
 * Both verify the provider's signature header before trusting the payload —
 * fill in FLW_SECRET_HASH / PAYSTACK verification per each provider's docs.
 * For local development/demo, use POST /api/transactions/simulate-deposit instead.
 */
router.post('/flutterwave', asyncHandler(async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!env.providers.flutterwave.webhookHash) {
    // Every real Flutterwave webhook will hit this every single time until
    // FLW_WEBHOOK_HASH is set on Railway — logged loudly (not just the
    // generic "invalid signature" line below) since this exact
    // misconfiguration silently blocks all deposits from ever crediting.
    logger.warn('Flutterwave webhook rejected: FLW_WEBHOOK_HASH is not configured on this server, so no incoming webhook can ever pass signature verification. Set it on Railway to match the Secret Hash configured on your Flutterwave dashboard (Settings > Webhooks).');
    return res.status(401).json({ success: false });
  }
  if (!signature || signature !== env.providers.flutterwave.webhookHash) {
    logger.warn('Flutterwave webhook received with invalid signature.');
    return res.status(401).json({ success: false });
  }

  const event = req.body;
  if (event.event === 'charge.completed' && event.data.status === 'successful') {
    // IMPORTANT: Flutterwave's charge.completed payload for a deposit into a
    // static/permanent virtual account does NOT reliably include an
    // account_number field anywhere (confirmed against Flutterwave's own NGN
    // Virtual Accounts docs) — only tx_ref and an internal numeric
    // account_id. The old code matched on event.data.meta?.account_number /
    // event.data.customer?.account_number, which don't exist in the real
    // payload, so it silently never found a wallet and never credited
    // anything — with no log line, since there was no `else` branch. This
    // is almost certainly why deposits weren't showing up in the app.
    //
    // Fix: match primarily on tx_ref (which Flutterwave echoes back
    // unchanged on every deposit into a given static virtual account — see
    // virtual_accounts.tx_ref, set at KYC-approval time). Still check
    // account_number as a fallback in case a payload variant does include
    // it, but tx_ref is the reliable one.
    const txRef = event.data.tx_ref;
    const accountNumber = event.data.meta?.account_number || event.data.customer?.account_number || event.data.account_number;

    const { rows } = await query(
      `SELECT w.* FROM wallets w
       LEFT JOIN virtual_accounts va ON va.wallet_id = w.id
       WHERE va.tx_ref = $1 OR ($2::text IS NOT NULL AND w.virtual_account = $2)
       LIMIT 1`,
      [txRef || null, accountNumber || null]
    );

    if (!rows.length) {
      // This used to fail completely silently. Logging the full payload
      // here means the next time a deposit doesn't land, Railway logs will
      // show exactly why (unknown tx_ref, no matching virtual account, etc.)
      // instead of leaving no trace at all.
      logger.warn(`Flutterwave charge.completed webhook could not be matched to any wallet — tx_ref=${txRef}, accountNumber=${accountNumber}, amount=${event.data.amount}. Raw event.data: ${JSON.stringify(event.data)}`);
    } else {
      const wallet = rows[0];

      // Idempotency guard: Flutterwave retries webhooks that don't respond
      // fast enough or return a non-2xx, which could otherwise double-credit
      // the same deposit. tx_ref is unique per transaction here (Flutterwave
      // generates a fresh one per deposit, distinct from the account's
      // creation tx_ref), so skip if we've already recorded it.
      const { rows: existing } = await query(
        `SELECT id FROM transactions WHERE wallet_id = $1 AND provider_reference = $2 AND type = 'deposit_external'`,
        [wallet.id, txRef]
      );

      if (existing.length) {
        logger.warn(`Flutterwave charge.completed webhook received again for an already-credited deposit (tx_ref=${txRef}) — skipping to avoid double-crediting.`);
      } else {
        const grossAmount = event.data.amount;
        const fee = await feeService.calculateFee('deposit_external', grossAmount);
        const creditTxn = await withTransaction(async (client) => {
          return walletService.creditWallet(client, {
            walletId: wallet.id, amount: grossAmount - fee, type: 'deposit_external', provider: 'flutterwave',
            providerReference: txRef, counterparty: { name: event.data.customer?.name, bank: event.data.customer?.bank },
            narration: 'Inbound bank deposit', meta: { grossAmount, fee },
          });
        });
        await tierLimitService.flagDepositIfOverTier({ userId: wallet.user_id, walletId: wallet.id, txnId: creditTxn.id, amount: grossAmount - fee });
      }
    }
  }

  // Reconciles bank payouts initiated via POST /api/wallet/transfer-to-bank —
  // those were debited immediately with status 'pending' at initiation time
  // (see wallet.controller.js), since Flutterwave confirms transfers
  // asynchronously rather than in the initiating API response.
  if (event.event === 'transfer.completed') {
    const providerRef = String(event.data.id);
    const { rows: txnRows } = await query(`SELECT * FROM transactions WHERE provider_reference = $1 AND status = 'pending'`, [providerRef]);
    if (txnRows.length) {
      const txn = txnRows[0];
      if (event.data.status === 'SUCCESSFUL') {
        await query(`UPDATE transactions SET status = 'success' WHERE id = $1`, [txn.id]);
      } else {
        await withTransaction(async (client) => {
          await walletService.reverseDebit(client, { originalTxn: txn, reason: event.data.complete_message || 'Bank transfer failed at the provider.' });
        });
      }
    } else {
      logger.warn(`Flutterwave transfer.completed webhook received for unknown/already-settled reference: ${providerRef}`);
    }
  }

  res.status(200).json({ success: true });
}));

router.post('/paystack', asyncHandler(async (req, res) => {
  const crypto = require('crypto');
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(JSON.stringify(req.body)).digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    logger.warn('Paystack webhook received with invalid signature.');
    return res.status(401).json({ success: false });
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const accountNumber = event.data.authorization?.receiver_bank_account_number;
    const { rows } = await query('SELECT * FROM wallets WHERE virtual_account = $1', [accountNumber]);
    if (!rows.length) {
      logger.warn(`Paystack charge.success webhook could not be matched to any wallet — accountNumber=${accountNumber}, reference=${event.data.reference}, amount=${event.data.amount}.`);
    } else {
      const wallet = rows[0];
      const { rows: existing } = await query(
        `SELECT id FROM transactions WHERE wallet_id = $1 AND provider_reference = $2 AND type = 'deposit_external'`,
        [wallet.id, event.data.reference]
      );
      if (existing.length) {
        logger.warn(`Paystack charge.success webhook received again for an already-credited deposit (reference=${event.data.reference}) — skipping to avoid double-crediting.`);
      } else {
        const grossAmount = event.data.amount / 100;
        const fee = await feeService.calculateFee('deposit_external', grossAmount);
        const creditTxn = await withTransaction(async (client) => {
          return walletService.creditWallet(client, {
            walletId: wallet.id, amount: grossAmount - fee, type: 'deposit_external', provider: 'paystack',
            providerReference: event.data.reference, narration: 'Inbound bank deposit', meta: { grossAmount, fee },
          });
        });
        await tierLimitService.flagDepositIfOverTier({ userId: wallet.user_id, walletId: wallet.id, txnId: creditTxn.id, amount: grossAmount - fee });
      }
    }
  }

  // Reconciles bank payouts initiated via POST /api/wallet/transfer-to-bank
  // when Paystack was the provider that ended up handling the transfer
  // (providerManager falls back between Flutterwave/Paystack automatically).
  if (event.event === 'transfer.success' || event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
    const providerRef = String(event.data.id ?? event.data.transfer_code);
    const { rows: txnRows } = await query(`SELECT * FROM transactions WHERE provider_reference = $1 AND status = 'pending'`, [providerRef]);
    if (txnRows.length) {
      const txn = txnRows[0];
      if (event.event === 'transfer.success') {
        await query(`UPDATE transactions SET status = 'success' WHERE id = $1`, [txn.id]);
      } else {
        await withTransaction(async (client) => {
          await walletService.reverseDebit(client, { originalTxn: txn, reason: event.data.reason || 'Bank transfer failed at the provider.' });
        });
      }
    } else {
      logger.warn(`Paystack transfer webhook received for unknown/already-settled reference: ${providerRef}`);
    }
  }

  res.status(200).json({ success: true });
}));

module.exports = router;
