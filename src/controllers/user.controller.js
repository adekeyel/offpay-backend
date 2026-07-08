const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');

async function getProfile(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, bvn, passport_url, status, kyc_status, kyc_notes,
            two_fa_enabled, is_email_verified, is_phone_verified, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];
  // Mask BVN for display — never return it in full over the wire after registration
  user.bvn = user.bvn ? `${'*'.repeat(7)}${user.bvn.slice(-4)}` : null;
  res.json({ success: true, data: user });
}

async function setTransactionPin(req, res) {
  const { pin, currentPassword } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) throw ApiError.badRequest('PIN must be exactly 4 digits.');
  if (!currentPassword) throw ApiError.badRequest('Please confirm your account password to set a PIN.');

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) throw ApiError.unauthorized('Incorrect password.');

  const pinHash = await bcrypt.hash(pin, env.security.bcryptSaltRounds);
  await query('UPDATE users SET pin_hash = $1, updated_at = now() WHERE id = $2', [pinHash, req.user.id]);
  res.json({ success: true, message: 'Transaction PIN set successfully.' });
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw ApiError.badRequest('currentPassword and newPassword are required.');
  if (newPassword.length < 8) throw ApiError.badRequest('New password must be at least 8 characters.');

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!valid) throw ApiError.unauthorized('Current password is incorrect.');

  const newHash = await bcrypt.hash(newPassword, env.security.bcryptSaltRounds);
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [newHash, req.user.id]);
  res.json({ success: true, message: 'Password updated successfully.' });
}

module.exports = { getProfile, setTransactionPin, changePassword };
