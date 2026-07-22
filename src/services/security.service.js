const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { encrypt, decrypt } = require('../utils/encryption');
const totp = require('../utils/totp');
const otpService = require('./otp.service');

async function getSettings(userId) {
  const { rows } = await query(
    `SELECT transfer_protection_enabled, biometrics_enabled, google2fa_enabled,
            email2fa_withdrawals_enabled, (app_lock_pin_hash IS NOT NULL) AS passcode_set
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  return rows[0];
}

async function setTransferProtection(userId, enabled) {
  await query('UPDATE users SET transfer_protection_enabled = $1, updated_at = now() WHERE id = $2', [!!enabled, userId]);
}

/**
 * Biometrics live entirely on-device (Face ID / fingerprint / WebAuthn
 * platform authenticator) — this just records the user's preference so it's
 * reflected consistently across their devices and on this settings screen.
 */
async function setBiometrics(userId, enabled) {
  await query('UPDATE users SET biometrics_enabled = $1, updated_at = now() WHERE id = $2', [!!enabled, userId]);
}

/** Step 1 of turning on Google 2FA: generate a secret, return it (+ QR) unconfirmed. Not enabled yet. */
async function startGoogle2faSetup(userId, email) {
  const secret = totp.generateSecret();
  await query('UPDATE users SET google2fa_secret_encrypted = $1, google2fa_enabled = false, updated_at = now() WHERE id = $2', [encrypt(secret), userId]);
  const otpauthUrl = totp.buildOtpAuthUrl({ secret, accountName: email });
  return { secret, otpauthUrl };
}

/** Step 2: user enters the 6-digit code their authenticator app is showing. Only now does it actually turn on. */
async function confirmGoogle2faSetup(userId, code) {
  const { rows } = await query('SELECT google2fa_secret_encrypted FROM users WHERE id = $1', [userId]);
  if (!rows[0]?.google2fa_secret_encrypted) throw ApiError.badRequest('Start Google 2FA setup first.');
  const secret = decrypt(rows[0].google2fa_secret_encrypted);
  if (!totp.verifyToken(secret, code)) throw ApiError.badRequest('Incorrect or expired code. Please try again.');
  await query('UPDATE users SET google2fa_enabled = true, updated_at = now() WHERE id = $1', [userId]);
}

async function disableGoogle2fa(userId) {
  await query('UPDATE users SET google2fa_enabled = false, google2fa_secret_encrypted = NULL, updated_at = now() WHERE id = $1', [userId]);
}

async function setEmail2faWithdrawals(userId, enabled) {
  await query('UPDATE users SET email2fa_withdrawals_enabled = $1, updated_at = now() WHERE id = $2', [!!enabled, userId]);
}

/**
 * Called before any ONLINE transfer (sendToBank / sendInApp). Never called
 * for offline-queued transfers — those are authorized by the device's
 * on-device signature at the time they were created (see
 * offlineVoucher.controller.js), and email OTP delivery requires network
 * that isn't available offline by definition, so enforcing it there would
 * just lock the user out of a feature that exists specifically for when
 * they have no connectivity.
 *
 * Requires verification when EITHER:
 *   - transfer_protection_enabled is on (every online transfer, any amount), OR
 *   - the amount is at/above env.security.largeTransferOtpThreshold
 * and only if the user has actually enabled a 2FA method to check against —
 * a user with neither Google 2FA nor Email 2FA enabled isn't blocked (there
 * is nothing to verify), but this is surfaced to the client so the app can
 * prompt them to enable one when they're moving that kind of money.
 */
async function enforceTransferOtp({ userId, email, amount, otpCode }) {
  const { rows } = await query(
    `SELECT transfer_protection_enabled, google2fa_enabled, google2fa_secret_encrypted, email2fa_withdrawals_enabled
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  const u = rows[0];

  const requiresCheck = u.transfer_protection_enabled || parseFloat(amount) >= env.security.largeTransferOtpThreshold;
  if (!requiresCheck) return;

  if (!u.google2fa_enabled && !u.email2fa_withdrawals_enabled) return; // nothing configured to check against

  if (!otpCode) {
    const method = u.google2fa_enabled ? 'google' : 'email';
    const err = ApiError.forbidden(
      method === 'google'
        ? 'This transfer requires your Google Authenticator code.'
        : 'This transfer requires the OTP sent to your email. Request one first.'
    );
    // Machine-readable so the client can render an OTP prompt instead of
    // just showing the message as a dead-end error.
    err.details = { code: 'TRANSFER_OTP_REQUIRED', method };
    throw err;
  }

  if (u.google2fa_enabled) {
    const secret = decrypt(u.google2fa_secret_encrypted);
    if (!totp.verifyToken(secret, otpCode)) throw ApiError.unauthorized('Incorrect Google Authenticator code.');
    return;
  }

  await otpService.verifyOtp({ userId, code: otpCode, purpose: 'transaction' });
}

/** Sends the emailed transaction OTP — called by the client only when email2fa (not Google 2FA) is the active method. */
async function requestTransferOtp({ userId, email }) {
  await otpService.issueOtp({ userId, destination: email, channel: 'email', purpose: 'transaction' });
}

module.exports = {
  getSettings,
  setTransferProtection,
  setBiometrics,
  startGoogle2faSetup,
  confirmGoogle2faSetup,
  disableGoogle2fa,
  setEmail2faWithdrawals,
  enforceTransferOtp,
  requestTransferOtp,
};
