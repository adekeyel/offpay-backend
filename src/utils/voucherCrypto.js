const crypto = require('crypto');

/**
 * Verifies an Ed25519 signature from a mobile device's raw public key.
 *
 * The native app signs with @noble/ed25519 (or equivalent), which produces
 * raw 32-byte public keys and 64-byte signatures — not Node's own DER/PEM
 * key format. This reconstructs a usable key object from the raw bytes via
 * JWK rather than requiring the client to produce a full DER-wrapped key.
 *
 * @param {string} publicKeyBase64 - raw 32-byte Ed25519 public key, base64-encoded
 * @param {string} message - the exact signed_payload string
 * @param {string} signatureBase64 - raw 64-byte signature, base64-encoded
 * @returns {boolean}
 */
function verifyVoucherSignature(publicKeyBase64, message, signatureBase64) {
  try {
    const rawKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawKey.length !== 32) return false;

    const jwk = { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') };
    const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });

    const signature = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObject, signature);
  } catch {
    // Malformed key/signature — treat as unverified rather than throwing,
    // so a corrupt voucher fails cleanly instead of crashing the request.
    return false;
  }
}

/**
 * Builds the canonical string a voucher's signature covers. Both the sender
 * device and this backend must construct this identically, or verification
 * will always fail even for a genuinely valid signature.
 */
function buildVoucherPayload({ senderId, receiverId, amount, nonce, timestamp }) {
  return `${senderId}|${receiverId}|${Number(amount).toFixed(2)}|${nonce}|${timestamp}`;
}

module.exports = { verifyVoucherSignature, buildVoucherPayload };
