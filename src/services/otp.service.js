const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { query } = require('../config/db');
const { randomDigits } = require('../utils/idGenerators');
const ApiError = require('../utils/ApiError');
const mailer = require('./mailer.service');

/** Generates, hashes, stores, and "sends" (mocked) an OTP */
async function issueOtp({ userId, destination, channel = 'email', purpose }) {
  const code = randomDigits(env.security.otpLength);
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + env.security.otpExpiryMinutes * 60 * 1000);

  await query(
    `INSERT INTO otps (user_id, channel, destination, code_hash, purpose, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, channel, destination, codeHash, purpose, expiresAt]
  );

  if (channel === 'email') {
    await mailer.sendOtpEmail(destination, code, purpose);
  } else {
    // SMS provider is mocked — swap in Termii / Africa's Talking / Twilio here.
    console.log(`[MOCK SMS to ${destination}] Your OffPay ${purpose} code is ${code}. Expires in ${env.security.otpExpiryMinutes} minutes.`);
  }

  return { expiresAt };
}

async function verifyOtp({ userId, code, purpose }) {
  const { rows } = await query(
    `SELECT * FROM otps
     WHERE user_id = $1 AND purpose = $2 AND consumed = false
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]
  );
  if (!rows.length) throw ApiError.badRequest('No active code found. Please request a new one.');

  const otp = rows[0];
  if (new Date(otp.expires_at) < new Date()) {
    throw ApiError.badRequest('This code has expired. Please request a new one.');
  }
  if (otp.attempts >= env.security.otpMaxAttempts) {
    throw ApiError.tooMany('Too many incorrect attempts. Please request a new code.');
  }

  const isValid = await bcrypt.compare(String(code), otp.code_hash);
  if (!isValid) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    throw ApiError.badRequest('Incorrect code.');
  }

  await query('UPDATE otps SET consumed = true WHERE id = $1', [otp.id]);
  return true;
}

module.exports = { issueOtp, verifyOtp };
