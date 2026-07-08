const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const otpService = require('../services/otp.service');
const tokenService = require('../services/token.service');
const { generateWalletId, generateVirtualAccountNumber } = require('../utils/idGenerators');
const auditService = require('../services/audit.service');

/**
 * Registration collects everything required to open a fintech wallet in
 * Nigeria: full legal name (must match BVN), email, phone, BVN, and a
 * passport photo. The account is created in `pending_kyc` status — it
 * cannot send/receive money until an admin (compliance role) approves it,
 * at which point a virtual account/card is generated.
 */
async function register(req, res) {
  const { fullName, email, phone, bvn, password } = req.body;
  const passportUrl = req.file ? `/uploads/${req.file.filename}` : null;

  if (!fullName || !email || !phone || !bvn || !password) {
    throw ApiError.badRequest('Full name, email, phone, BVN, and password are all required.');
  }
  if (!/^\d{11}$/.test(bvn)) throw ApiError.badRequest('BVN must be exactly 11 digits.');
  if (password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters.');
  if (!passportUrl) throw ApiError.badRequest('A passport photograph is required for identity verification.');

  const existing = await query('SELECT id FROM users WHERE email = $1 OR phone = $2 OR bvn = $3', [email, phone, bvn]);
  if (existing.rows.length) {
    throw ApiError.conflict('An account already exists with this email, phone number, or BVN.');
  }

  const passwordHash = await bcrypt.hash(password, env.security.bcryptSaltRounds);

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (full_name, email, phone, bvn, passport_url, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, full_name, email, phone, status, kyc_status`,
      [fullName, email, phone, bvn, passportUrl, passwordHash]
    );
    const newUser = rows[0];

    // Wallet is created immediately but stays unusable for money movement
    // until KYC is approved — see middleware/auth.js requireApprovedKyc.
    await client.query(
      `INSERT INTO wallets (user_id, wallet_id) VALUES ($1,$2)`,
      [newUser.id, generateWalletId()]
    );

    return newUser;
  });

  await otpService.issueOtp({ userId: user.id, destination: email, channel: 'email', purpose: 'register' });
  await auditService.logAction({ actorType: 'user', actorId: user.id, action: 'REGISTER', targetType: 'user', targetId: user.id, ipAddress: req.ip });

  res.status(201).json({
    success: true,
    message: 'Account created. Please verify the OTP sent to your email, then wait for KYC approval before you can transact.',
    data: { userId: user.id, email: user.email, kycStatus: user.kyc_status },
  });
}

async function verifyEmailOtp(req, res) {
  const { userId, code } = req.body;
  if (!userId || !code) throw ApiError.badRequest('userId and code are required.');

  await otpService.verifyOtp({ userId, code, purpose: 'register' });
  await query('UPDATE users SET is_email_verified = true WHERE id = $1', [userId]);

  res.json({ success: true, message: 'Email verified. Your account is now pending KYC review by our compliance team.' });
}

async function login(req, res) {
  const { email, password, deviceId } = req.body;
  if (!email || !password || !deviceId) throw ApiError.badRequest('Email, password, and deviceId are required.');

  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  if (!rows.length) throw ApiError.unauthorized('Incorrect email or password.');
  const user = rows[0];

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw ApiError.forbidden('This account is temporarily locked due to repeated failed login attempts. Try again later.');
  }
  if (['blocked', 'suspended', 'deleted'].includes(user.status)) {
    throw ApiError.forbidden(`Your account is ${user.status}. Please contact support.`);
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    const failedCount = user.failed_login_count + 1;
    const lockUntil = failedCount >= 5 ? new Date(Date.now() + 30 * 60 * 1000) : null;
    await query('UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3', [failedCount, lockUntil, user.id]);
    throw ApiError.unauthorized('Incorrect email or password.');
  }

  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);

  // Standard fintech practice: always require a fresh OTP step on login (2FA)
  await otpService.issueOtp({ userId: user.id, destination: user.email, channel: 'email', purpose: 'login' });

  res.json({
    success: true,
    message: 'Password verified. Enter the OTP sent to your email to complete login.',
    data: { userId: user.id, requiresOtp: true, deviceId },
  });
}

async function verifyLoginOtp(req, res) {
  const { userId, code, deviceId, userAgent } = req.body;
  if (!userId || !code || !deviceId) throw ApiError.badRequest('userId, code, and deviceId are required.');

  await otpService.verifyOtp({ userId, code, purpose: 'login' });

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw ApiError.notFound('Account not found.');

  const accessToken = tokenService.signUserAccessToken(user, deviceId);
  const refreshToken = tokenService.signUserRefreshToken(user, deviceId);
  const refreshTokenHash = tokenService.hashToken(refreshToken);

  await query(
    `INSERT INTO sessions (user_id, device_id, refresh_token_hash, user_agent, ip_address, is_online, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,true,now())`,
    [user.id, deviceId, refreshTokenHash, userAgent || req.headers['user-agent'], req.ip]
  );
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await auditService.logAction({ actorType: 'user', actorId: user.id, action: 'LOGIN', ipAddress: req.ip });

  res.json({
    success: true,
    message: 'Login successful.',
    data: {
      accessToken,
      refreshToken,
      user: { id: user.id, fullName: user.full_name, email: user.email, status: user.status, kycStatus: user.kyc_status },
    },
  });
}

async function refresh(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken) throw ApiError.badRequest('refreshToken is required.');

  let payload;
  try {
    payload = tokenService.verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Refresh token is invalid or expired. Please log in again.');
  }

  const tokenHash = tokenService.hashToken(refreshToken);
  const { rows } = await query(
    `SELECT * FROM sessions WHERE user_id = $1 AND device_id = $2 AND refresh_token_hash = $3 AND revoked = false`,
    [payload.sub, payload.deviceId, tokenHash]
  );
  if (!rows.length) throw ApiError.unauthorized('Session not recognized. Please log in again.');

  const { rows: userRows } = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!userRows.length) throw ApiError.unauthorized('Account not found.');

  const accessToken = tokenService.signUserAccessToken(userRows[0], payload.deviceId);
  await query('UPDATE sessions SET last_seen_at = now(), is_online = true WHERE id = $1', [rows[0].id]);

  res.json({ success: true, data: { accessToken } });
}

async function logout(req, res) {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const tokenHash = tokenService.hashToken(refreshToken);
    await query('UPDATE sessions SET revoked = true, is_online = false WHERE refresh_token_hash = $1', [tokenHash]);
  }
  res.json({ success: true, message: 'Logged out.' });
}

/** Called by the client to mark a device online/offline (heartbeat), used for offline-token issuance decisions. */
async function heartbeat(req, res) {
  const { deviceId, isOnline } = req.body;
  await query(
    `UPDATE sessions SET is_online = $1, last_seen_at = now() WHERE user_id = $2 AND device_id = $3`,
    [isOnline !== false, req.user.id, deviceId]
  );
  res.json({ success: true });
}

/**
 * Public "I'm locked out" entry point (forgotten password/PIN, lost device, etc).
 * Deliberately does NOT reset anything itself — it only logs a request for the
 * admin Recovery Center to review and action, since resets need identity checks
 * a same-session API call can't perform on its own.
 */
async function requestRecovery(req, res) {
  const { email, type, reason } = req.body;
  const allowedTypes = ['password_reset', 'pin_reset', 'device_change', 'account_lockout'];
  if (!email || !type) throw ApiError.badRequest('email and type are required.');
  if (!allowedTypes.includes(type)) throw ApiError.badRequest(`type must be one of: ${allowedTypes.join(', ')}`);

  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);
  // Always respond the same way whether or not the email exists, to avoid leaking account existence.
  if (rows.length) {
    await query(
      `INSERT INTO recovery_requests (user_id, type, reason) VALUES ($1,$2,$3)`,
      [rows[0].id, type, reason || null]
    );
  }
  res.json({ success: true, message: 'If that email is registered, our recovery team has been notified and will be in touch.' });
}

module.exports = { register, verifyEmailOtp, login, verifyLoginOtp, refresh, logout, heartbeat, requestRecovery };
