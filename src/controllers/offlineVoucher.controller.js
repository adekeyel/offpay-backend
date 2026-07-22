const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const feeService = require('../services/fee.service');
const auditService = require('../services/audit.service');
const pushService = require('../services/push.service');
const { verifyVoucherSignature, buildVoucherPayload } = require('../utils/voucherCrypto');

// NOTE on Security Settings (Transfer Protection / Google 2FA / Email 2FA
// for withdrawals): none of those are checked anywhere in this file, and
// that's intentional. Offline vouchers are authorized by the sending
// device's on-device Ed25519 signature at creation time (see
// verifyVoucherSignature below), not by a live OTP prompt — there is no
// network to deliver an emailed code or reach this backend for a Google 2FA
// round trip while offline. Enforcing those settings here would just lock
// users out of the offline-transfer feature entirely. They only apply to
// the online endpoints (transaction.controller.js sendToBank/sendInApp).

/**
 * Called by the RECEIVER's device once it has connectivity, reporting a
 * voucher it received directly from a sender (via QR/Bluetooth/NFC) that
 * hasn't been synced by the sender yet. This is what makes the "pending"
 * side of GET /wallet/balance real and durable — without this, a receiver
 * who reinstalls the app or switches devices before the sender syncs would
 * have no record of the incoming amount at all, since it would only ever
 * have existed in that one device's local state.
 *
 * This does NOT move any money and does NOT re-verify the signature — that
 * happens once, authoritatively, in syncVoucher below, against the sender's
 * key on file. This endpoint only records that the receiver is expecting a
 * transfer, so it can be shown and reconciled even before the sender syncs.
 */
async function reportIncoming(req, res) {
  const { senderId, senderDeviceId, amount, nonce, timestamp, signature } = req.body;
  if (!senderId || !senderDeviceId || !amount || !nonce || !timestamp || !signature) {
    throw ApiError.badRequest('senderId, senderDeviceId, amount, nonce, timestamp, and signature are required.');
  }

  const { rows: existing } = await query('SELECT * FROM offline_vouchers WHERE nonce = $1', [nonce]);
  if (existing.length) {
    // Sender may have already synced this (or the receiver's device retried
    // reporting it) — either way, just return the current state.
    return res.json({ success: true, data: existing[0] });
  }

  const payload = buildVoucherPayload({ senderId, receiverId: req.user.id, amount, nonce, timestamp });
  const { rows } = await query(
    `INSERT INTO offline_vouchers (sender_id, receiver_id, sender_device_id, amount, nonce, signature, signed_payload, status, receiver_notified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_sync',now()) RETURNING *`,
    [senderId, req.user.id, senderDeviceId, amount, nonce, signature, payload]
  );
  res.status(201).json({ success: true, message: 'Incoming transfer recorded as pending.', data: rows[0] });
}

/**
 * Called by the SENDER's device once it regains connectivity, submitting a
 * voucher it signed while offline. This is the ONLY point at which money
 * actually moves — it re-verifies the signature and the sender's real,
 * current balance from scratch, regardless of what the receiver's device
 * showed locally or reported via reportIncoming above. If either check
 * fails, nothing is credited and the failure is recorded with a reason
 * rather than the receiver's pending entry silently vanishing.
 *
 * If the receiver already called reportIncoming for this exact voucher
 * (same nonce), that existing row is UPDATED in place rather than a
 * duplicate being inserted — nonce is UNIQUE, and this also preserves
 * receiver_notified_at for an accurate audit trail either way round.
 */
async function syncVoucher(req, res) {
  const { receiverId, amount, nonce, timestamp, signature, deviceId } = req.body;
  if (!receiverId || !amount || !nonce || !timestamp || !signature || !deviceId) {
    throw ApiError.badRequest('receiverId, amount, nonce, timestamp, signature, and deviceId are required.');
  }
  if (receiverId === req.user.id) throw ApiError.badRequest('Cannot send an offline transfer to yourself.');

  const { rows: existingRows } = await query('SELECT * FROM offline_vouchers WHERE nonce = $1', [nonce]);
  const existing = existingRows[0] || null;
  if (existing && existing.status !== 'pending_sync') {
    // Already fully processed — idempotent no-op on retry (e.g. a dropped
    // connection right after the first successful sync attempt).
    return res.json({ success: existing.status === 'confirmed', message: `Voucher already ${existing.status}.`, data: existing });
  }

  const { rows: deviceRows } = await query(
    'SELECT public_key FROM devices WHERE user_id = $1 AND device_id = $2',
    [req.user.id, deviceId]
  );
  const publicKey = deviceRows[0]?.public_key;
  if (!publicKey) throw ApiError.badRequest('This device has no registered signing key. Call POST /devices/key first.');

  const payload = buildVoucherPayload({ senderId: req.user.id, receiverId, amount, nonce, timestamp });
  const signatureValid = verifyVoucherSignature(publicKey, payload, signature);

  if (!signatureValid) {
    const voucher = await saveVoucherOutcome({
      existing, senderId: req.user.id, receiverId, deviceId, amount, nonce, signature, payload,
      status: 'failed', failureReason: 'Signature verification failed',
    });
    throw ApiError.badRequest('Voucher signature could not be verified.', { voucher });
  }

  const { rows: receiverRows } = await query('SELECT id FROM users WHERE id = $1', [receiverId]);
  if (!receiverRows.length) throw ApiError.notFound('Receiver account not found.');

  const { rows: senderWalletRows } = await query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const senderWallet = senderWalletRows[0];
  const { rows: receiverWalletRows } = await query('SELECT * FROM wallets WHERE user_id = $1', [receiverId]);
  const receiverWallet = receiverWalletRows[0];

  const fee = await feeService.calculateFee('transfer_offline', parseFloat(amount));
  const total = parseFloat(amount) + fee;

  if (senderWallet.is_frozen) {
    return failAndRespond(res, { existing, senderId: req.user.id, receiverId, deviceId, amount, nonce, signature, payload, reason: 'Sender wallet is frozen.' });
  }
  if (parseFloat(senderWallet.balance) < total) {
    return failAndRespond(res, { existing, senderId: req.user.id, receiverId, deviceId, amount, nonce, signature, payload, reason: 'Insufficient balance at sync time.' });
  }

  let result;
  try {
    result = await withTransaction(async (client) => {
      // Enforces the 60/40 offline lock: this voucher must fit within the
      // sender's active offline token's remaining allowance. Done inside
      // the same transaction as the debit (with a row lock on the token)
      // so two vouchers syncing concurrently can't both slip under the cap.
      await walletService.reserveOfflineSpend(client, { walletId: senderWallet.id, amount: parseFloat(amount) });

      const debitTxn = await walletService.debitWallet(client, {
        walletId: senderWallet.id, amount: parseFloat(amount), fee, type: 'transfer_offline', provider: 'internal',
        narration: `Offline transfer to ${receiverId}`, counterparty: { name: receiverId, number: receiverWallet.wallet_id },
      });
      await walletService.creditWallet(client, {
        walletId: receiverWallet.id, amount: parseFloat(amount), type: 'transfer_offline', provider: 'internal',
        narration: `Offline transfer received`, counterparty: { name: req.user.id, number: senderWallet.wallet_id },
      });

      const voucher = await saveVoucherOutcome({
        existing, senderId: req.user.id, receiverId, deviceId, amount, nonce, signature, payload,
        status: 'confirmed', transactionId: debitTxn.id, client,
      });
      return { voucher, debitTxn };
    });
  } catch (err) {
    // Covers the offline-cap rejection above, and any other failure inside
    // the transaction (e.g. a race that dropped the balance in between) —
    // either way, the receiver's already-recorded 'pending_sync' entry (if
    // they called reportIncoming) needs an actual resolution, not to hang
    // forever with no explanation.
    return failAndRespond(res, { existing, senderId: req.user.id, receiverId, deviceId, amount, nonce, signature, payload, reason: err.message || 'Offline transfer could not be completed.' });
  }

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'OFFLINE_VOUCHER_SYNCED', targetType: 'offline_voucher', targetId: result.voucher.id, ipAddress: req.ip });

  const { rows: receiverDevices } = await query('SELECT expo_push_token FROM devices WHERE user_id = $1 AND expo_push_token IS NOT NULL', [receiverId]);
  await Promise.all(receiverDevices.map((d) => pushService.sendPushNotification(d.expo_push_token, {
    title: 'Money received',
    body: `₦${Number(amount).toLocaleString()} just landed in your wallet.`,
    data: { type: 'offline_voucher_confirmed', voucherId: result.voucher.id },
  })));

  res.json({ success: true, message: 'Offline transfer confirmed.', data: result.voucher });
}

/** Inserts a fresh voucher row, or updates an existing receiver-reported 'pending_sync' one in place. */
async function saveVoucherOutcome({ existing, senderId, receiverId, deviceId, amount, nonce, signature, payload, status, failureReason, transactionId, client }) {
  const db = client || { query };
  if (existing) {
    const { rows } = await db.query(
      `UPDATE offline_vouchers SET status = $1, failure_reason = $2, transaction_id = $3, synced_at = now() WHERE id = $4 RETURNING *`,
      [status, failureReason || null, transactionId || null, existing.id]
    );
    return rows[0];
  }
  const { rows } = await db.query(
    `INSERT INTO offline_vouchers (sender_id, receiver_id, sender_device_id, amount, nonce, signature, signed_payload, status, failure_reason, transaction_id, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [senderId, receiverId, deviceId, amount, nonce, signature, payload, status, failureReason || null, transactionId || null, status === 'pending_sync' ? null : new Date()]
  );
  return rows[0];
}

async function failAndRespond(res, { existing, senderId, receiverId, deviceId, amount, nonce, signature, payload, reason }) {
  const voucher = await saveVoucherOutcome({ existing, senderId, receiverId, deviceId, amount, nonce, signature, payload, status: 'failed', failureReason: reason });

  const { rows: receiverDevices } = await query('SELECT expo_push_token FROM devices WHERE user_id = $1 AND expo_push_token IS NOT NULL', [receiverId]);
  await Promise.all(receiverDevices.map((d) => pushService.sendPushNotification(d.expo_push_token, {
    title: 'Incoming transfer failed',
    body: `An expected ₦${Number(amount).toLocaleString()} transfer could not be completed: ${reason}`,
    data: { type: 'offline_voucher_failed', voucherId: voucher.id },
  })));

  res.status(400).json({ success: false, message: reason, data: voucher });
}

/** History of offline transfers this user was either the sender or receiver of. */
async function history(req, res) {
  const { rows } = await query(
    `SELECT ov.*, su.full_name AS sender_name, ru.full_name AS receiver_name
     FROM offline_vouchers ov
     JOIN users su ON su.id = ov.sender_id
     JOIN users ru ON ru.id = ov.receiver_id
     WHERE ov.sender_id = $1 OR ov.receiver_id = $1
     ORDER BY ov.created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
}

module.exports = { reportIncoming, syncVoucher, history };
