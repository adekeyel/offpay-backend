const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const tokenService = require('../services/token.service');
const otpService = require('../services/otp.service');
const auditService = require('../services/audit.service');

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) throw ApiError.badRequest('Email and password are required.');

  const { rows } = await query('SELECT * FROM admin_users WHERE email = $1', [email]);
  if (!rows.length) throw ApiError.unauthorized('Incorrect email or password.');
  const admin = rows[0];
  if (admin.status !== 'active') throw ApiError.forbidden('This admin account is suspended.');

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) throw ApiError.unauthorized('Incorrect email or password.');

  await otpService.issueOtp({ userId: null, destination: admin.email, channel: 'email', purpose: 'login' });
  // Store which admin this OTP belongs to via a short-lived pending record (reuse otps.user_id is user-scoped,
  // so for admins we pass the email back to the client and re-derive the admin on verify).
  res.json({ success: true, message: 'Enter the OTP sent to your email to complete login.', data: { email: admin.email, requiresOtp: true } });
}

async function verifyOtp(req, res) {
  const { email, code } = req.body;
  const { rows } = await query('SELECT * FROM admin_users WHERE email = $1', [email]);
  if (!rows.length) throw ApiError.notFound('Admin not found.');
  const admin = rows[0];

  // Admin OTPs are stored with user_id = null and matched by destination email
  const otpRows = await query(
    `SELECT * FROM otps WHERE destination = $1 AND purpose = 'login' AND consumed = false ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  if (!otpRows.rows.length) throw ApiError.badRequest('No active code found. Please request a new one.');
  const otp = otpRows.rows[0];
  if (new Date(otp.expires_at) < new Date()) throw ApiError.badRequest('This code has expired.');
  const isValid = await bcrypt.compare(String(code), otp.code_hash);
  if (!isValid) {
    await query('UPDATE otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
    throw ApiError.badRequest('Incorrect code.');
  }
  await query('UPDATE otps SET consumed = true WHERE id = $1', [otp.id]);

  const accessToken = tokenService.signAdminAccessToken(admin);
  await query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [admin.id]);
  await auditService.logAction({ actorType: 'admin', actorId: admin.id, action: 'ADMIN_LOGIN', ipAddress: req.ip });

  res.json({
    success: true,
    data: { accessToken, admin: { id: admin.id, fullName: admin.full_name, email: admin.email, role: admin.role } },
  });
}

/** admin-role only: create additional admin accounts with a scoped role */
async function createAdmin(req, res) {
  const { fullName, email, password, role } = req.body;
  const allowedRoles = ['admin', 'support', 'compliance', 'finance', 'operations'];
  if (!fullName || !email || !password || !role) throw ApiError.badRequest('fullName, email, password, and role are required.');
  if (!allowedRoles.includes(role)) throw ApiError.badRequest(`role must be one of: ${allowedRoles.join(', ')}`);

  const existing = await query('SELECT id FROM admin_users WHERE email = $1', [email]);
  if (existing.rows.length) throw ApiError.conflict('An admin with this email already exists.');

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(
    `INSERT INTO admin_users (full_name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, full_name, email, role`,
    [fullName, email, hash, role]
  );
  await auditService.logAction({ actorType: 'admin', actorId: req.admin.id, action: 'CREATE_ADMIN', targetType: 'admin_user', targetId: rows[0].id, meta: { role } });
  res.status(201).json({ success: true, data: rows[0] });
}

module.exports = { login, verifyOtp, createAdmin };
