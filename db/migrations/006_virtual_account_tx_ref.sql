-- ============================================================================
-- Fix for deposits not crediting wallets: Flutterwave's charge.completed
-- webhook for a bank transfer into a static/permanent virtual account does
-- NOT reliably include the account_number in the payload (only tx_ref and
-- an internal numeric account_id — see Flutterwave's NGN Virtual Accounts
-- docs). The old webhook handler only ever looked for account_number, so it
-- silently never matched a wallet and never logged anything about it.
--
-- Storing the tx_ref used at virtual-account-creation time (e.g.
-- "OP-VA-<userId>") lets webhook.routes.js reliably look the wallet back up
-- by tx_ref, which Flutterwave does echo back on every deposit into that
-- account.
-- ============================================================================

ALTER TABLE virtual_accounts ADD COLUMN IF NOT EXISTS tx_ref VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_virtual_accounts_tx_ref ON virtual_accounts(tx_ref);

-- Backfill existing rows using the deterministic tx_ref format
-- (OP-VA-<userId>) this codebase has always used at creation time
-- (see adminKyc.controller.js), so already-issued accounts keep working
-- without needing a fresh KYC approval.
UPDATE virtual_accounts va
SET tx_ref = 'OP-VA-' || w.user_id
FROM wallets w
WHERE va.wallet_id = w.id AND va.tx_ref IS NULL;
