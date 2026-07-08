const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');

function signUserAccessToken(user, deviceId) {
  return jwt.sign({ sub: user.id, type: 'user', deviceId }, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpiresIn });
}

function signUserRefreshToken(user, deviceId) {
  return jwt.sign({ sub: user.id, type: 'user', deviceId }, env.jwt.refreshSecret, { expiresIn: env.jwt.refreshExpiresIn });
}

function signAdminAccessToken(admin) {
  return jwt.sign({ sub: admin.id, type: 'admin', role: admin.role }, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpiresIn });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  signUserAccessToken,
  signUserRefreshToken,
  signAdminAccessToken,
  verifyRefreshToken,
  hashToken,
};
