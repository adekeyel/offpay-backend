const { query } = require('../config/db');
const providerManager = require('../services/providers/providerManager');
const logger = require('../utils/logger');

// Bank lists change rarely (a new Nigerian bank/MFB launching is a rare
// event), so the live provider list is cached in the `banks` table and only
// re-fetched once a day — this keeps the endpoint fast and avoids hammering
// Flutterwave/Paystack on every screen load.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the full Nigerian bank list for the "Send to bank" picker.
 *
 * Previously this only ever returned the ~20 banks hand-seeded in db/seed.js
 * (see BANKS in that file) — nowhere near Nigeria's 50+ banks/MFBs, and the
 * likely reason "Send to bank" felt broken for accounts at banks outside
 * that starter list. This now refreshes from the live provider (whichever
 * of Flutterwave/Paystack/Monnify is configured — see providerManager.js)
 * once a day and upserts the result into `banks`, which stays the source of
 * truth the rest of the time. If the live fetch fails for any reason
 * (provider outage, no keys configured yet, etc.), it falls back to
 * whatever is already cached rather than erroring the whole screen out.
 */
async function listBanks(req, res) {
  const { rows: cached } = await query(
    `SELECT id, name, code, country, updated_at FROM banks ORDER BY name ASC`
  );
  const newestUpdate = cached.reduce((max, b) => Math.max(max, new Date(b.updated_at).getTime()), 0);
  const isStale = !cached.length || Date.now() - newestUpdate > CACHE_TTL_MS;

  if (isStale) {
    try {
      const liveBanks = await providerManager.listBanks();
      if (liveBanks.length) {
        for (const bank of liveBanks) {
          if (!bank.code || !bank.name) continue;
          await query(
            `INSERT INTO banks (name, code, country, updated_at)
             VALUES ($1, $2, 'Nigeria', now())
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
            [bank.name, bank.code]
          );
        }
        const { rows: refreshed } = await query(
          `SELECT id, name, code, country FROM banks ORDER BY name ASC`
        );
        return res.json({ success: true, data: refreshed });
      }
    } catch (err) {
      logger.warn(`Could not refresh live bank list from provider — serving cached list instead: ${err.message}`);
    }
  }

  res.json({ success: true, data: cached.map(({ updated_at, ...bank }) => bank) });
}

module.exports = { listBanks };
