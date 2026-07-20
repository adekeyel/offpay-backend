const { query, withTransaction } = require('../config/db');
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
 * Refreshes from the live provider (whichever of Flutterwave/Paystack/
 * Monnify is configured — see providerManager.js) once a day and REPLACES
 * the `banks` table wholesale with the result, which stays the source of
 * truth the rest of the time. It's a full replace rather than an upsert on
 * top of the existing rows deliberately: the hand-seeded starter list in
 * db/seed.js used NIBSS-style codes (e.g. 999992 for Opay/Paycom), but
 * Flutterwave's own bank codebook doesn't always match NIBSS codes for
 * fintech/mobile-money institutions (Flutterwave lists Opay as code 100004,
 * for example) — upserting on `code` would leave both the old, incompatible
 * seed row and the new, correct one sitting in the picker side by side,
 * where a user could still pick the wrong one and get "Unknown Bank Code"
 * back from Flutterwave. A full replace means only codes the currently
 * configured provider actually recognizes are ever shown. If the live fetch
 * fails for any reason (provider outage, no keys configured yet, etc.), it
 * falls back to whatever is already cached rather than erroring the whole
 * screen out.
 */
async function listBanks(req, res) {
  const { rows: cached } = await query(
    `SELECT id, name, code, country, updated_at FROM banks ORDER BY name ASC`
  );
  const newestUpdate = cached.reduce((max, b) => Math.max(max, new Date(b.updated_at).getTime()), 0);
  const isStale = !cached.length || Date.now() - newestUpdate > CACHE_TTL_MS || req.query.refresh === '1';

  if (isStale) {
    try {
      const liveBanks = await providerManager.listBanks();
      const valid = liveBanks.filter((b) => b.code && b.name);
      if (valid.length) {
        const refreshed = await withTransaction(async (client) => {
          await client.query('DELETE FROM banks');
          for (const bank of valid) {
            await client.query(
              `INSERT INTO banks (name, code, country, updated_at) VALUES ($1, $2, 'Nigeria', now())
               ON CONFLICT (code) DO NOTHING`,
              [bank.name, bank.code]
            );
          }
          const { rows } = await client.query(`SELECT id, name, code, country FROM banks ORDER BY name ASC`);
          return rows;
        });
        return res.json({ success: true, data: refreshed, meta: { source: 'live', fetchedCount: valid.length } });
      }
      // The provider call succeeded but returned an empty/unusable list —
      // note this explicitly rather than silently falling through, since it
      // looks identical to a total failure otherwise.
      return res.json({
        success: true,
        data: cached.map(({ updated_at, ...bank }) => bank),
        meta: { source: 'cache', reason: 'Live provider returned no usable banks (empty or missing code/name fields).' },
      });
    } catch (err) {
      logger.warn(`Could not refresh live bank list from provider — serving cached list instead: ${err.message}`);
      return res.json({
        success: true,
        data: cached.map(({ updated_at, ...bank }) => bank),
        meta: { source: 'cache', reason: err.message },
      });
    }
  }

  res.json({ success: true, data: cached.map(({ updated_at, ...bank }) => bank), meta: { source: 'cache', reason: 'Cache is still fresh (refreshed within the last 24h).' } });
}

module.exports = { listBanks };
