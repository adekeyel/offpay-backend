const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');
const auditService = require('../services/audit.service');
const providerManager = require('../services/providers/providerManager');
const { decrypt } = require('../utils/encryption');

async function getMyCard(req, res) {
  const { rows } = await query('SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [req.user.id]);
  res.json({ success: true, data: rows[0] || null });
}

/**
 * Issues a real virtual card via the provider layer (currently Flutterwave —
 * see flutterwave.provider.js's issueCard for what's confirmed vs. what you
 * should verify against your live dashboard before relying on this).
 *
 * Requires approved KYC (enforced by the route middleware) because a card
 * carries the same BVN-linked identity requirement as the virtual account —
 * we don't issue a card for an unverified user.
 */
async function createCard(req, res) {
  const { rows: existing } = await query(`SELECT 1 FROM cards WHERE user_id = $1 AND status != 'expired'`, [req.user.id]);
  if (existing.length) throw ApiError.badRequest('You already have an active virtual card.');

  const { rows: userRows } = await query('SELECT full_name, email, bvn_encrypted, kyc_status FROM users WHERE id = $1', [req.user.id]);
  const user = userRows[0];
  if (user.kyc_status !== 'approved') throw ApiError.forbidden('Your identity must be verified before a card can be issued.');
  if (!user.bvn_encrypted) throw ApiError.badRequest('No BVN on file for this account.');

  let issued;
  try {
    issued = await providerManager.issueCard({
      userId: req.user.id,
      bvn: decrypt(user.bvn_encrypted),
      email: user.email,
      fullName: user.full_name,
    });
  } catch (err) {
    // Deliberately no fake/mock fallback here — if no provider can issue a
    // real card, the user needs to know that plainly rather than receive
    // fabricated card data that will fail the moment they try to use it.
    throw ApiError.badGateway(`Could not issue a card right now: ${err.message}`);
  }

  const { rows } = await query(
    `INSERT INTO cards (user_id, provider, provider_card_id, masked_pan, last4, brand, expiry_month, expiry_year)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id, issued.providerUsed || issued.provider, issued.providerCardId, issued.maskedPan, issued.last4, issued.brand, issued.expiryMonth, issued.expiryYear]
  );
  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'CARD_CREATED', targetType: 'card', targetId: rows[0].id, meta: { provider: issued.providerUsed }, ipAddress: req.ip });
  res.status(201).json({ success: true, data: rows[0] });
}

/** action: freeze | unfreeze | block */
async function updateStatus(req, res) {
  const { action } = req.body;
  if (!['freeze', 'unfreeze', 'block'].includes(action)) throw ApiError.badRequest('Invalid action.');

  const { rows } = await query('SELECT * FROM cards WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) throw ApiError.notFound('Card not found.');
  if (rows[0].status === 'blocked') throw ApiError.badRequest('This card is permanently blocked and cannot be changed.');

  const nextStatus = action === 'freeze' ? 'frozen' : action === 'unfreeze' ? 'active' : 'blocked';
  const { rows: updated } = await query('UPDATE cards SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [nextStatus, req.params.id]);
  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: `CARD_${action.toUpperCase()}`, targetType: 'card', targetId: req.params.id, ipAddress: req.ip });
  res.json({ success: true, data: updated[0] });
}

module.exports = { getMyCard, createCard, updateStatus };
