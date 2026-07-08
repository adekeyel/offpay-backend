const crypto = require('crypto');

function randomDigits(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/** Human-readable wallet id, e.g. OP-4821-9376 */
function generateWalletId() {
  return `OP-${randomDigits(4)}-${randomDigits(4)}`;
}

/** 10-digit NUBAN-style mock virtual account number (used when no live provider account exists) */
function generateVirtualAccountNumber() {
  return `90${randomDigits(8)}`;
}

/** Transaction reference, e.g. OP-TXN-1720012345-A1B2C3 */
function generateTxnReference() {
  const ts = Date.now();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `OP-TXN-${ts}-${rand}`;
}

/** Idempotency-safe offline queue key generator (also accepted from client) */
function generateIdempotencyKey() {
  return crypto.randomUUID();
}

module.exports = {
  generateWalletId,
  generateVirtualAccountNumber,
  generateTxnReference,
  generateIdempotencyKey,
  randomDigits,
};
