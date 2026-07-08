const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { query } = require('../config/db');

/** Requires a valid user access token. Attaches req.user = { id, email, status, kycStatus } */
async function requireUserAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw ApiError.unauthorized('Missing access token.');

    let payload;
    try {
      payload = jwt.verify(token, env.jwt.accessSecret);
    } catch {
      throw ApiError.unauthorized('Access token is invalid or has expired.');
    }
    if (payload.type !== 'user') throw ApiError.unauthorized('Invalid token type.');

    const { rows } = await query(
      `SELECT id, email, full_name, status, kyc_status, two_fa_enabled FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!rows.length) throw ApiError.unauthorized('Account not found.');
    const user = rows[0];

    if (['blocked', 'suspended', 'deleted'].includes(user.status)) {
      throw ApiError.forbidden(`Your account is currently ${user.status}. Contact support for help.`);
    }

    req.user = { id: user.id, email: user.email, fullName: user.full_name, status: user.status, kycStatus: user.kyc_status };
    req.deviceId = payload.deviceId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Requires KYC to be approved (blocks access to money-movement endpoints until admin approves) */
function requireApprovedKyc(req, res, next) {
  if (req.user?.kycStatus !== 'approved') {
    return next(ApiError.forbidden('Your account is still pending verification. This action unlocks once an admin approves your KYC.'));
  }
  next();
}

/** Requires a valid admin access token. Attaches req.admin = { id, email, role } */
async function requireAdminAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw ApiError.unauthorized('Missing access token.');

    let payload;
    try {
      payload = jwt.verify(token, env.jwt.accessSecret);
    } catch {
      throw ApiError.unauthorized('Access token is invalid or has expired.');
    }
    if (payload.type !== 'admin') throw ApiError.unauthorized('Invalid token type.');

    const { rows } = await query(`SELECT id, email, full_name, role, status FROM admin_users WHERE id = $1`, [payload.sub]);
    if (!rows.length) throw ApiError.unauthorized('Admin account not found.');
    const admin = rows[0];
    if (admin.status !== 'active') throw ApiError.forbidden('This admin account is suspended.');

    req.admin = { id: admin.id, email: admin.email, fullName: admin.full_name, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** Role-based access control for admin routes. Usage: requireRole('admin', 'finance') */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) return next(ApiError.unauthorized());
    // 'admin' role always has full access across every module
    if (req.admin.role === 'admin' || allowedRoles.includes(req.admin.role)) return next();
    return next(ApiError.forbidden(`This action requires one of these roles: ${allowedRoles.join(', ')}`));
  };
}

module.exports = { requireUserAuth, requireApprovedKyc, requireAdminAuth, requireRole };
