const AIRTIME_CASHBACK_MIN_AMOUNT = 200;
const AIRTIME_CASHBACK_FLAT_AMOUNT = 2;

/**
 * Flat ₦2 cashback on any airtime purchase of ₦200 or more. Not tiered, not
 * percentage-based — same ₦2 whether the purchase is ₦200 or ₦50,000.
 * Deliberately computed here, server-side, from the confirmed purchase
 * amount — never trust a cashback figure sent by the client.
 */
function calculateAirtimeCashback(purchaseAmount) {
  return purchaseAmount >= AIRTIME_CASHBACK_MIN_AMOUNT ? AIRTIME_CASHBACK_FLAT_AMOUNT : 0;
}

/** Credits cashback within the caller's existing DB transaction, if the rule earns anything. */
async function creditCashback(client, { userId, amount, source, referenceId }) {
  if (amount <= 0) return null;
  const { rows } = await client.query(
    `INSERT INTO cashback_ledger (user_id, amount, source, reference_id) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, amount, source, referenceId]
  );
  return rows[0];
}

async function getCashbackBalance(query, userId) {
  const { rows } = await query('SELECT COALESCE(SUM(amount), 0) AS balance FROM cashback_ledger WHERE user_id = $1', [userId]);
  return parseFloat(rows[0].balance);
}

module.exports = { calculateAirtimeCashback, creditCashback, getCashbackBalance, AIRTIME_CASHBACK_MIN_AMOUNT, AIRTIME_CASHBACK_FLAT_AMOUNT };
