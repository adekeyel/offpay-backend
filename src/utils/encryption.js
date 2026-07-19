const crypto = require('crypto');
const env = require('../config/env');

/**
 * AES-256-GCM field-level encryption, used for BVN (and any future
 * field-level-encrypted PII). ENCRYPTION_KEY can be any-length string --
 * it's hashed down to a proper 32-byte key here, so operators don't have to
 * hand-generate exact hex/base64 key material themselves.
 */
function getKey() {
  return crypto.createHash('sha256').update(String(env.encryptionKey)).digest();
}

/** Returns base64(iv + authTag + ciphertext) as a single string, safe to store in one TEXT column. */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Deterministic "blind index": same input always produces the same output,
 * so it can back a UNIQUE constraint and equality lookups (e.g. "has this
 * BVN already registered?") without ever storing or comparing plaintext.
 * Uses HMAC (keyed) rather than plain SHA-256, so it can't be reversed via
 * a rainbow table of all ~10^11 possible BVNs by anyone without this key.
 */
function blindIndex(plaintext) {
  return crypto.createHmac('sha256', getKey()).update(String(plaintext)).digest('hex');
}

/** Masked display, e.g. "*******1234" — safe to show in any UI without decrypting. */
function maskLast4(plaintext) {
  const s = String(plaintext);
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, blindIndex, maskLast4 };
