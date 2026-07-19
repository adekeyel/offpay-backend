-- ============================================================================
-- One-time data migration:
--   1. Deposit/withdrawal fees: flat-per-amount-range -> percentage of amount
--      (matches provider cost + a small margin instead of losing money on
--      larger transactions).
--   2. Loans restricted to KYC Tier 3 only.
--   3. Savings interest rates reduced ~3 points across every product.
--   4. Per-tier withdrawal-only limits consolidated into one tier_limits key
--      that also covers max balance and daily deposit limit.
--   5. loans table gains reviewed_by / reviewed_at / rejection_reason
--      (also present in schema.sql for fresh installs — IF NOT EXISTS here
--      makes this safe to run against a DB that already has them).
--
-- Runs exactly once (tracked in _migrations by db/migrate.js). After this,
-- every value below is a normal editable row — change fees from
-- Admin > Fees, loan product tiers from Admin > Loan Products, savings
-- rates from Admin > Wealth Products, and tier caps from Admin > Settings.
-- Nothing here re-applies on the next deploy.
-- ============================================================================

ALTER TABLE loans ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES admin_users(id);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- --- 1. Fees ---------------------------------------------------------------
DELETE FROM fee_config WHERE code IN (
  'DEPOSIT_EXTERNAL_BELOW_1000',
  'DEPOSIT_EXTERNAL_1000_PLUS',
  'WITHDRAWAL_INTERBANK_BELOW_10000',
  'WITHDRAWAL_INTERBANK_ABOVE_10000'
);

INSERT INTO fee_config (code, label, txn_type, min_amount, max_amount, fee_type, fee_value) VALUES
  ('DEPOSIT_EXTERNAL', 'Deposit from other bank', 'deposit_external', 0, NULL, 'percentage', 3.5),
  ('WITHDRAWAL_INTERBANK', 'Interbank transfer to another bank', 'withdrawal_interbank', 0, NULL, 'percentage', 10.5)
ON CONFLICT (code) DO NOTHING;

UPDATE fee_config SET fee_type = 'percentage', fee_value = 10.5
WHERE code = 'WITHDRAWAL_INTRA_BANK' AND fee_type = 'flat';

-- --- 2. Loans: Tier 3 only ---------------------------------------------------
UPDATE loan_products SET min_kyc_tier = 3;

-- --- 3. Savings interest: reduce ~3 points, floor at 1% ---------------------
UPDATE wealth_products SET interest_rate = GREATEST(interest_rate - 3, 1);

-- --- 4. Consolidated tier limits ---------------------------------------------
DELETE FROM platform_settings WHERE key IN ('withdrawal_limit_tier1', 'withdrawal_limit_tier2', 'withdrawal_limit_tier3');

INSERT INTO platform_settings (key, value, label) VALUES
  ('tier_limits', '{
     "tier1": {"maxBalance": 200000, "dailyDepositLimit": 50000, "dailyOutgoingLimit": 50000},
     "tier2": {"maxBalance": 500000, "dailyDepositLimit": 200000, "dailyOutgoingLimit": 200000},
     "tier3": {"maxBalance": 100000000, "dailyDepositLimit": 30000000, "dailyOutgoingLimit": 5000000}
   }', 'KYC tier caps: max wallet balance, daily deposit limit, daily withdrawal/transfer limit (₦)')
ON CONFLICT (key) DO NOTHING;
