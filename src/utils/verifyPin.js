const bcrypt = require('bcryptjs');
const { query } = require('../config/db');
const ApiError = require('./ApiError');

/**
 * Verifies a user's transaction PIN before authorizing money movement
 * (e.g. bank payouts). Throws if no PIN has been set yet, or if it doesn't
 * match — callers don't need to check either case separately.
 */
async function requireValidPin(userId, pin) {
  if (!pin || !/^\d{4}$/.test(pin)) throw ApiError.badRequest('A valid 4-digit transaction PIN is required.');

  const { rows } = await query('SELECT pin_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0]?.pin_hash) {
    throw ApiError.badRequest('You have not set a transaction PIN yet. Set one in Settings & Security first.');
  }
  const valid = await bcrypt.compare(pin, rows[0].pin_hash);
  if (!valid) throw ApiError.unauthorized('Incorrect transaction PIN.');
}

module.exports = { requireValidPin };
