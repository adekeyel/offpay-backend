const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder) {
    const chunk = bits.slice(bits.length - remainder).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue; // skip spaces/dashes some authenticator apps insert
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Generates a new random 20-byte (160-bit) TOTP secret, base32-encoded for authenticator apps. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** RFC 6238 TOTP code for a given base32 secret and unix-seconds timestamp (30s step, 6 digits — Google Authenticator defaults). */
function generateToken(base32Secret, forTimeSeconds = Math.floor(Date.now() / 1000), step = 30, digits = 6) {
  const counter = Math.floor(forTimeSeconds / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const key = base32Decode(base32Secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

/** Verifies a 6-digit code, allowing +/- 1 step (30s) of clock drift, as every authenticator app expects. */
function verifyToken(base32Secret, token, window = 1) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (generateToken(base32Secret, now + errorWindow * 30) === String(token)) return true;
  }
  return false;
}

/** otpauth:// URI that authenticator apps (Google Authenticator, Authy, etc.) scan as a QR code. */
function buildOtpAuthUrl({ secret, accountName, issuer = 'OffPay' }) {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, generateToken, verifyToken, buildOtpAuthUrl };
