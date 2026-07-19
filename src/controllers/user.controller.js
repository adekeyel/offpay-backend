const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { encrypt, decrypt, maskLast4 } = require('../utils/encryption');
const auditService = require('../services/audit.service');

async function getProfile(req, res) {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, bvn_encrypted, passport_url, status, kyc_status, kyc_tier, kyc_notes,
            address, tier_upgrade_status, tier_upgrade_notes, two_fa_enabled, is_email_verified, is_phone_verified, created_at
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!rows.length) throw ApiError.notFound('User not found.');
  const { bvn_encrypted, ...user } = rows[0];
  // Mask BVN for display — never return it in full over the wire after registration
  user.bvn = bvn_encrypted ? maskLast4(decrypt(bvn_encrypted)) : null;
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

/**
 * Lets a user with an already-approved base KYC (Tier 1) request an upgrade
 * to a higher verification tier by submitting their NIN, a photo/scan of the
 * NIN slip, a recent utility bill, and their address.
 *
 * This only FILES the request — kyc_tier is not changed here. It sets
 * tier_upgrade_status to 'pending' for an admin (compliance role) to review
 * via GET /api/admin/kyc/tier-upgrades/pending and then
 * POST /api/admin/kyc/tier-upgrades/:id/approve or /reject
 * (see adminKyc.controller.js).
 */
async function requestTierUpgrade(req, res) {
  const { nin, address } = req.body;
  const ninSlipUrl = req.files?.ninSlip?.[0] ? `/uploads/${req.files.ninSlip[0].filename}` : null;
  const utilityBillUrl = req.files?.utilityBill?.[0] ? `/uploads/${req.files.utilityBill[0].filename}` : null;

  if (!nin || !/^\d{11}$/.test(nin)) throw ApiError.badRequest('A valid 11-digit NIN is required.');
  if (!address) throw ApiError.badRequest('Address is required.');
  if (!ninSlipUrl) throw ApiError.badRequest('A photo or scan of your NIN slip is required.');
  if (!utilityBillUrl) throw ApiError.badRequest('A recent utility bill is required.');

  const { rows } = await query('SELECT kyc_status, kyc_tier, tier_upgrade_status FROM users WHERE id = $1', [req.user.id]);
  if (!rows.length) throw ApiError.notFound('User not found.');
  const user = rows[0];

  if (user.kyc_status !== 'approved') {
    throw ApiError.forbidden('Complete your initial identity verification before requesting a tier upgrade.');
  }
  if (user.kyc_tier >= 3) throw ApiError.conflict('You are already at the highest verification tier.');
  if (user.tier_upgrade_status === 'pending') {
    throw ApiError.conflict('You already have a tier upgrade request pending review.');
  }

  await query(
    `UPDATE users
     SET nin_encrypted = $1, nin_slip_url = $2, utility_bill_url = $3, address = $4, address_updated_at = now(),
         tier_upgrade_status = 'pending', tier_upgrade_notes = NULL, updated_at = now()
     WHERE id = $5`,
    [encrypt(nin), ninSlipUrl, utilityBillUrl, address, req.user.id]
  );

  await auditService.logAction({
    actorType: 'user', actorId: req.user.id, action: 'TIER_UPGRADE_REQUEST',
    targetType: 'user', targetId: req.user.id, ipAddress: req.ip,
  });

  res.status(201).json({
    success: true,
    message: 'Tier upgrade request submitted. This is usually reviewed within 24-48 hours.',
  });
}

module.exports = { getProfile, setTransactionPin, changePassword, requestTierUpgrade };
