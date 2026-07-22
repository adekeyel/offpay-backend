const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const feeService = require('../services/fee.service');
const providerManager = require('../services/providers/providerManager');
const pdfService = require('../services/pdf.service');
const auditService = require('../services/audit.service');
const fraudService = require('../services/fraud.service');
const tierLimitService = require('../services/tierLimit.service');
const securityService = require('../services/security.service');
const env = require('../config/env');
const { generateTxnReference } = require('../utils/idGenerators');

/**
 * Send money to any Nigerian (or supported international) bank account.
 * Determines intra-bank vs interbank fee based on whether the destination
 * bank matches the sender's own virtual account bank.
 */
async function sendToBank(req, res) {
  const { bankCode, bankName, accountNumber, accountName, amount, narration, pin, otpCode } = req.body;
  if (!bankCode || !accountNumber || !amount) throw ApiError.badRequest('bankCode, accountNumber, and amount are required.');
  if (amount <= 0) throw ApiError.badRequest('Amount must be greater than zero.');

  await verifyTransactionPin(req.user.id, pin);
  // Online-only — never enforced on offline-queued transfers. See
  // security.service.js enforceTransferOtp() for the full explanation.
  await securityService.enforceTransferOtp({ userId: req.user.id, email: req.user.email, amount, otpCode });

  const wallet = await walletService.getWalletByUserId(req.user.id);
  await tierLimitService.enforceOutgoingLimit({ userId: req.user.id, walletId: wallet.id, amount });
  const isIntraBank = wallet.virtual_bank && bankName && wallet.virtual_bank.toLowerCase() === bankName.toLowerCase();
  const feeType = isIntraBank ? 'withdrawal_intra_bank' : 'withdrawal_interbank';
  const fee = await feeService.calculateFee(feeType, amount);

  const reference = generateTxnReference();

  const txn = await withTransaction(async (client) => {
    return walletService.debitWallet(client, {
      walletId: wallet.id,
      amount,
      fee,
      type: 'withdrawal_external', // intra vs interbank distinction is fee-relevant only; recorded in meta.isIntraBank below
      provider: 'pending',
      providerReference: reference,
      counterparty: { name: accountName, bank: bankName, number: accountNumber },
      narration: narration || `Transfer to ${accountName || accountNumber}`,
      meta: { isIntraBank },
    });
  });

  try {
    const result = await providerManager.initiateTransfer({
      amount, bankCode, accountNumber, narration: narration || 'OffPay transfer', reference,
    });
    await query(`UPDATE transactions SET provider = $1, provider_reference = $2 WHERE id = $3`, [result.providerUsed, result.providerRef, txn.id]);
  } catch (err) {
    // Provider failed on both primary and fallback — reverse the debit automatically.
    await withTransaction(async (client) => {
      await walletService.creditWallet(client, {
        walletId: wallet.id, amount: parseFloat(amount) + parseFloat(fee), type: 'reversal',
        narration: `Reversal: ${txn.reference} (provider failure)`, meta: { originalTxnId: txn.id },
      });
      await client.query(`UPDATE transactions SET status = 'reversed' WHERE id = $1`, [txn.id]);
    });
    throw ApiError.badRequest('We could not complete this transfer with any available provider. Your funds have been refunded.');
  }

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'SEND_TO_BANK', targetType: 'transaction', targetId: txn.id, ipAddress: req.ip });
  fraudService.evaluateTransaction(txn, req.user.id);

  res.status(201).json({ success: true, message: 'Transfer sent.', data: { reference: txn.reference, fee, amount } });
}

/** Send to another OffPay user, in-app, by their Wallet ID or account number (online). */
async function sendInApp(req, res) {
  const { recipientWalletId, recipientAccountNumber, amount, narration, pin, otpCode } = req.body;
  if (!recipientWalletId && !recipientAccountNumber) throw ApiError.badRequest('Provide recipientWalletId or recipientAccountNumber.');
  if (!amount || amount <= 0) throw ApiError.badRequest('Amount must be greater than zero.');

  await verifyTransactionPin(req.user.id, pin);
  await securityService.enforceTransferOtp({ userId: req.user.id, email: req.user.email, amount, otpCode });

  const senderWallet = await walletService.getWalletByUserId(req.user.id);
  const recipientWallet = recipientWalletId
    ? await walletService.getWalletByWalletId(recipientWalletId)
    : await walletService.getWalletByAccountNumber(recipientAccountNumber);

  if (recipientWallet.id === senderWallet.id) throw ApiError.badRequest('You cannot send money to yourself.');

  await tierLimitService.enforceOutgoingLimit({ userId: req.user.id, walletId: senderWallet.id, amount });
  const fee = await feeService.calculateFee('transfer_in_app', amount);
  const { rows: recipientUserRows } = await query('SELECT full_name FROM users WHERE id = $1', [recipientWallet.user_id]);

  const result = await withTransaction(async (client) => {
    const debitTxn = await walletService.debitWallet(client, {
      walletId: senderWallet.id, amount, fee, type: 'transfer_in_app',
      counterparty: { name: recipientUserRows[0]?.full_name, number: recipientWallet.wallet_id },
      narration: narration || 'OffPay transfer',
    });
    const creditTxn = await walletService.creditWallet(client, {
      walletId: recipientWallet.id, amount, type: 'transfer_in_app',
      counterparty: { name: req.user.fullName, number: senderWallet.wallet_id },
      narration: narration || 'OffPay transfer received',
    });
    return { debitTxn, creditTxn };
  });

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'SEND_IN_APP', targetType: 'transaction', targetId: result.debitTxn.id, ipAddress: req.ip });
  fraudService.evaluateTransaction(result.debitTxn, req.user.id);

  res.status(201).json({ success: true, message: 'Transfer successful.', data: { reference: result.debitTxn.reference, fee, amount } });
}

/**
 * Simulates an inbound deposit from an external bank (in production this is a
 * provider webhook — see routes/webhooks.routes.js). Exposed here in sandbox
 * mode so the app is demo-able without live provider credentials.
 */
async function simulateExternalDeposit(req, res) {
  // This endpoint fabricates a deposit with no real money movement — useful
  // for local dev/demo, but a real fintech app must never let a user credit
  // their own wallet out of thin air. Hard-disabled outside development.
  if (env.nodeEnv === 'production') {
    throw ApiError.notFound('Not available. Deposits are credited automatically when a real bank transfer lands in your virtual account.');
  }

  const { amount, senderName, senderBank } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('Amount must be greater than zero.');

  const wallet = await walletService.getWalletByUserId(req.user.id);
  await tierLimitService.enforceDepositLimit({ userId: req.user.id, walletId: wallet.id, amount });
  const fee = await feeService.calculateFee('deposit_external', amount);
  const netCredit = amount - fee;
  if (netCredit <= 0) throw ApiError.badRequest('Amount is too small after fees.');

  const txn = await withTransaction(async (client) => {
    return walletService.creditWallet(client, {
      walletId: wallet.id, amount: netCredit, type: 'deposit_external', provider: 'sandbox',
      counterparty: { name: senderName || 'External Sender', bank: senderBank || 'External Bank' },
      narration: `Deposit from ${senderBank || 'external bank'} (fee ₦${fee} deducted)`,
      meta: { grossAmount: amount, fee },
    });
  });

  res.status(201).json({ success: true, message: 'Deposit received.', data: { reference: txn.reference, netCredit, fee } });
}

async function history(req, res) {
  const wallet = await walletService.getWalletByUserId(req.user.id);
  const { limit = 20, offset = 0, type, status } = req.query;

  const conditions = ['wallet_id = $1'];
  const params = [wallet.id];
  if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT * FROM transactions WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ success: true, data: rows });
}

async function getReceipt(req, res) {
  const wallet = await walletService.getWalletByUserId(req.user.id);
  const { rows } = await query('SELECT * FROM transactions WHERE id = $1 AND wallet_id = $2', [req.params.id, wallet.id]);
  if (!rows.length) throw ApiError.notFound('Transaction not found.');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="OffPay-Receipt-${rows[0].reference}.pdf"`);
  pdfService.generateReceipt(rows[0], wallet, res);
}

async function getStatement(req, res) {
  const wallet = await walletService.getWalletByUserId(req.user.id);
  const { from, to } = req.query;
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  const { rows } = await query(
    `SELECT * FROM transactions WHERE wallet_id = $1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at ASC`,
    [wallet.id, fromDate, toDate]
  );
  const { rows: userRows } = await query('SELECT full_name, address FROM users WHERE id = $1', [req.user.id]);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="OffPay-Statement-${wallet.wallet_id}.pdf"`);
  pdfService.generateStatement({
    user: userRows[0], wallet, transactions: rows,
    from: fromDate.toDateString(), to: toDate.toDateString(),
  }, res);
}

/** Shared PIN check used before any money-movement action. */
async function verifyTransactionPin(userId, pin) {
  const bcrypt = require('bcryptjs');
  if (!pin) throw ApiError.badRequest('Transaction PIN is required.');
  const { rows } = await query('SELECT pin_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0]?.pin_hash) throw ApiError.badRequest('Please set a transaction PIN in Settings before making transfers.');
  const valid = await bcrypt.compare(String(pin), rows[0].pin_hash);
  if (!valid) throw ApiError.unauthorized('Incorrect transaction PIN.');
}

module.exports = { sendToBank, sendInApp, simulateExternalDeposit, history, getReceipt, getStatement };
