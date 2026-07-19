const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { query, withTransaction } = require('../config/db');
const walletService = require('../services/wallet.service');
const feeService = require('../services/fee.service');
const tierLimitService = require('../services/tierLimit.service');
const logger = require('../utils/logger');

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
  if (!signature || signature !== process.env.FLW_WEBHOOK_HASH) {
    logger.warn('Flutterwave webhook received with invalid signature.');
    return res.status(401).json({ success: false });
  }

  const event = req.body;
  if (event.event === 'charge.completed' && event.data.status === 'successful') {
    const accountNumber = event.data.meta?.account_number || event.data.customer?.account_number;
    const { rows } = await query('SELECT * FROM wallets WHERE virtual_account = $1', [accountNumber]);
    if (rows.length) {
      const wallet = rows[0];
      const grossAmount = event.data.amount;
      const fee = await feeService.calculateFee('deposit_external', grossAmount);
      const creditTxn = await withTransaction(async (client) => {
        return walletService.creditWallet(client, {
          walletId: wallet.id, amount: grossAmount - fee, type: 'deposit_external', provider: 'flutterwave',
          providerReference: event.data.tx_ref, counterparty: { name: event.data.customer?.name, bank: event.data.customer?.bank },
          narration: 'Inbound bank deposit', meta: { grossAmount, fee },
        });
      });
      await tierLimitService.flagDepositIfOverTier({ userId: wallet.user_id, walletId: wallet.id, txnId: creditTxn.id, amount: grossAmount - fee });
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
    if (rows.length) {
      const wallet = rows[0];
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
