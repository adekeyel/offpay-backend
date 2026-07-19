const { query } = require('../config/db');
const cashbackService = require('../services/cashback.service');

/**
 * Only cashback is real here — the spec gave a concrete rule for it
 * (flat ₦2 on airtime ≥ ₦200). Daily check-in streaks and the Reward Hub
 * are shown in the nav tree but have no specified mechanics (bonus amounts,
 * streak rules, claimable tasks) yet, so there's nothing to build server-side
 * for them until that's defined — the native app should treat those as
 * UI-only/placeholder sections for now, same as the web app's Rewards tab.
 */
async function getSummary(req, res) {
  const balance = await cashbackService.getCashbackBalance(query, req.user.id);
  const { rows: history } = await query(
    `SELECT * FROM cashback_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ success: true, data: { cashbackBalance: balance, cashbackHistory: history } });
}

module.exports = { getSummary };
