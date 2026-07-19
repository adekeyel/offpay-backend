const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

/**
 * KYC tier caps — admin-adjustable via platform_settings (key: 'tier_limits').
 * These defaults match the current business spec and are what gets seeded.
 *   Tier 1: max balance ₦200,000 — daily deposit ₦50,000 — daily withdrawal/transfer ₦50,000
 *   Tier 2: max balance ₦500,000 — daily deposit ₦200,000 — daily withdrawal/transfer ₦200,000
 *   Tier 3: max balance ₦100,000,000 — daily deposit ₦30,000,000 — daily withdrawal/transfer ₦5,000,000
 */
const DEFAULT_TIER_LIMITS = {
  1: { maxBalance: 200000, dailyDepositLimit: 50000, dailyOutgoingLimit: 50000 },
  2: { maxBalance: 500000, dailyDepositLimit: 200000, dailyOutgoingLimit: 200000 },
  3: { maxBalance: 100000000, dailyDepositLimit: 30000000, dailyOutgoingLimit: 5000000 },
};

// Actual txn_type enum values that count as "money leaving the wallet" for the
// combined daily withdrawal/transfer cap (withdrawal_interbank vs intra-bank
// is a fee-calculation distinction only — both are stored as withdrawal_external).
const OUTGOING_TXN_TYPES = ['withdrawal_external', 'transfer_in_app', 'transfer_offline'];

async function getTierLimits() {
  const { rows } = await query(`SELECT value FROM platform_settings WHERE key = 'tier_limits'`);
  if (!rows.length) return DEFAULT_TIER_LIMITS;
  const value = rows[0].value || {};
  return {
    1: normalizeTier(value.tier1) || DEFAULT_TIER_LIMITS[1],
    2: normalizeTier(value.tier2) || DEFAULT_TIER_LIMITS[2],
    3: normalizeTier(value.tier3) || DEFAULT_TIER_LIMITS[3],
  };
}

function normalizeTier(t) {
  if (!t) return null;
  return {
    maxBalance: parseFloat(t.maxBalance),
    dailyDepositLimit: parseFloat(t.dailyDepositLimit),
    dailyOutgoingLimit: parseFloat(t.dailyOutgoingLimit),
  };
}

async function getUserTier(userId) {
  const { rows } = await query('SELECT kyc_tier FROM users WHERE id = $1', [userId]);
  if (!rows.length) throw ApiError.notFound('Account not found.');
  return rows[0].kyc_tier;
}

async function sumToday(walletId, types) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE wallet_id = $1 AND type::text = ANY($2::text[])
       AND status IN ('success', 'pending')
       AND created_at >= date_trunc('day', now())`,
    [walletId, types]
  );
  return parseFloat(rows[0].total);
}

/**
 * Call before crediting an external deposit. Throws if the deposit would
 * push the wallet over its tier's max balance, or over today's deposit cap.
 */
async function enforceDepositLimit({ userId, walletId, amount }) {
  const [tier, limits, wallet] = await Promise.all([
    getUserTier(userId),
    getTierLimits(),
    query('SELECT balance FROM wallets WHERE id = $1', [walletId]),
  ]);
  const cap = limits[tier] || DEFAULT_TIER_LIMITS[1];
  const currentBalance = parseFloat(wallet.rows[0]?.balance || 0);

  if (currentBalance + parseFloat(amount) > cap.maxBalance) {
    throw ApiError.badRequest(
      `This deposit would take your wallet balance above the Tier ${tier} limit of ₦${cap.maxBalance.toLocaleString()}. Upgrade your KYC tier to hold more.`
    );
  }

  const usedToday = await sumToday(walletId, ['deposit_external']);
  if (usedToday + parseFloat(amount) > cap.dailyDepositLimit) {
    throw ApiError.badRequest(
      `This would exceed your Tier ${tier} daily deposit limit of ₦${cap.dailyDepositLimit.toLocaleString()} (₦${Math.max(0, cap.dailyDepositLimit - usedToday).toLocaleString()} remaining today).`
    );
  }
}

/**
 * Call before debiting for a withdrawal or transfer (bank payout, in-app
 * transfer, or offline transfer). Throws if it would exceed today's combined
 * withdrawal/transfer cap for the user's tier.
 */
async function enforceOutgoingLimit({ userId, walletId, amount }) {
  const [tier, limits] = await Promise.all([getUserTier(userId), getTierLimits()]);
  const cap = limits[tier] || DEFAULT_TIER_LIMITS[1];

  const usedToday = await sumToday(walletId, OUTGOING_TXN_TYPES);
  if (usedToday + parseFloat(amount) > cap.dailyOutgoingLimit) {
    throw ApiError.badRequest(
      `This would exceed your Tier ${tier} daily withdrawal/transfer limit of ₦${cap.dailyOutgoingLimit.toLocaleString()} (₦${Math.max(0, cap.dailyOutgoingLimit - usedToday).toLocaleString()} remaining today).`
    );
  }
}

/**
 * Real bank deposits arrive via provider webhook *after* the money has
 * already settled with Flutterwave/Paystack, so we can't reject them the
 * way we can a synchronous request — the funds are already the customer's.
 * Instead, credit as normal and raise a fraud_alerts entry for admin review
 * if the deposit pushed the wallet over its tier's cap. Never throws.
 */
async function flagDepositIfOverTier({ userId, walletId, txnId, amount }) {
  try {
    const [tier, limits, wallet] = await Promise.all([
      getUserTier(userId),
      getTierLimits(),
      query('SELECT balance FROM wallets WHERE id = $1', [walletId]),
    ]);
    const cap = limits[tier] || DEFAULT_TIER_LIMITS[1];
    const balance = parseFloat(wallet.rows[0]?.balance || 0);
    const usedToday = await sumToday(walletId, ['deposit_external']);

    const overBalance = balance > cap.maxBalance;
    const overDaily = usedToday > cap.dailyDepositLimit;
    if (!overBalance && !overDaily) return;

    const reason = overBalance
      ? `Wallet balance ₦${balance.toLocaleString()} exceeds the Tier ${tier} cap of ₦${cap.maxBalance.toLocaleString()} after this deposit.`
      : `Today's deposits (₦${usedToday.toLocaleString()}) exceed the Tier ${tier} daily deposit limit of ₦${cap.dailyDepositLimit.toLocaleString()}.`;

    await query(
      `INSERT INTO fraud_alerts (user_id, transaction_id, rule_code, severity, reason)
       VALUES ($1, $2, 'TIER_LIMIT_EXCEEDED', 'high', $3)
       ON CONFLICT DO NOTHING`,
      [userId, txnId, reason]
    );
  } catch {
    // Flagging must never block a deposit that has already settled with the provider.
  }
}

module.exports = { getTierLimits, enforceDepositLimit, enforceOutgoingLimit, flagDepositIfOverTier, DEFAULT_TIER_LIMITS };
