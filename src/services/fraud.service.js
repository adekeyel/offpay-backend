const { query } = require('../config/db');

const LARGE_AMOUNT_THRESHOLD = 500000; // ₦500,000 in a single transaction
const VELOCITY_WINDOW_MINUTES = 10;
const VELOCITY_MAX_TXNS = 5;

/**
 * Runs a lightweight rule-check against a just-created transaction and raises a
 * fraud_alerts row if anything trips. Fire-and-forget from the caller's perspective —
 * never throws, since a flagging failure must not block the underlying money movement.
 */
async function evaluateTransaction(txn, userId) {
  try {
    const amount = parseFloat(txn.amount);

    if (amount >= LARGE_AMOUNT_THRESHOLD) {
      await raiseAlert({
        userId, transactionId: txn.id, ruleCode: 'LARGE_AMOUNT', severity: 'high',
        reason: `Single transaction of ₦${amount.toLocaleString()} exceeds the ₦${LARGE_AMOUNT_THRESHOLD.toLocaleString()} large-amount threshold.`,
      });
    }

    const { rows } = await query(
      `SELECT COUNT(*) FROM transactions WHERE wallet_id = $1 AND created_at > now() - interval '${VELOCITY_WINDOW_MINUTES} minutes'`,
      [txn.wallet_id]
    );
    const recentCount = parseInt(rows[0].count, 10);
    if (recentCount > VELOCITY_MAX_TXNS) {
      await raiseAlert({
        userId, transactionId: txn.id, ruleCode: 'VELOCITY', severity: 'medium',
        reason: `${recentCount} transactions from this wallet in the last ${VELOCITY_WINDOW_MINUTES} minutes.`,
      });
    }
  } catch {
    // Never let fraud evaluation break the money-movement flow.
  }
}

async function raiseAlert({ userId, transactionId, ruleCode, severity, reason }) {
  // Avoid duplicate open alerts for the exact same transaction + rule
  const { rows: existing } = await query(
    `SELECT id FROM fraud_alerts WHERE transaction_id = $1 AND rule_code = $2`,
    [transactionId, ruleCode]
  );
  if (existing.length) return;
  await query(
    `INSERT INTO fraud_alerts (user_id, transaction_id, rule_code, severity, reason) VALUES ($1,$2,$3,$4,$5)`,
    [userId, transactionId, ruleCode, severity, reason]
  );
}

module.exports = { evaluateTransaction };
