-- ============================================================================
-- OffPay Database Schema
-- PostgreSQL 14+
-- Run via `npm run migrate` (see db/migrate.js) — idempotent, safe to re-run.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('pending_kyc', 'active', 'blocked', 'frozen', 'suspended', 'closed', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'closed';

DO $$ BEGIN
  CREATE TYPE kyc_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE admin_role AS ENUM ('admin', 'support', 'compliance', 'finance', 'operations', 'fraud', 'recovery');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Upgrading an existing database that already has the old enum values
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'fraud';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'recovery';

DO $$ BEGIN
  CREATE TYPE admin_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE txn_type AS ENUM (
    'deposit_external',        -- inbound from another Nigerian/foreign bank
    'withdrawal_external',     -- outbound to another bank (interbank/intra-bank)
    'transfer_in_app',         -- to another OffPay user by account/wallet id (online)
    'transfer_offline',        -- wallet-to-wallet while offline, synced later
    'fee',
    'reversal',
    'manual_adjustment'        -- super-admin manual wallet credit/debit
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE txn_type ADD VALUE IF NOT EXISTS 'manual_adjustment';

DO $$ BEGIN
  CREATE TYPE txn_direction AS ENUM ('credit', 'debit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE txn_status AS ENUM ('pending', 'success', 'failed', 'reversed', 'queued_offline');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE otp_purpose AS ENUM ('login', 'register', 'transaction', 'password_reset');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_action_type AS ENUM ('block', 'freeze', 'suspend', 'close', 'delete', 'reverse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE account_action_type ADD VALUE IF NOT EXISTS 'close';

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name           VARCHAR(150) NOT NULL,          -- must match BVN record
  email               VARCHAR(150) UNIQUE NOT NULL,
  phone               VARCHAR(20) UNIQUE NOT NULL,
  bvn                 VARCHAR(11) UNIQUE NOT NULL,
  passport_url        TEXT,                            -- uploaded passport photo
  password_hash       TEXT NOT NULL,
  pin_hash            TEXT,                             -- 4-digit transaction PIN
  status              user_status NOT NULL DEFAULT 'pending_kyc',
  kyc_status          kyc_status NOT NULL DEFAULT 'pending',
  kyc_reviewed_by     UUID,
  kyc_reviewed_at     TIMESTAMPTZ,
  kyc_notes           TEXT,
  is_email_verified   BOOLEAN NOT NULL DEFAULT false,
  is_phone_verified   BOOLEAN NOT NULL DEFAULT false,
  two_fa_enabled      BOOLEAN NOT NULL DEFAULT true,
  failed_login_count  INT NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  -- KYC tier: 1 = signup default (BVN + face match only), 2 = address + NIN slip,
  -- 3 = passport + utility bill (address must match the address captured at tier 2)
  kyc_tier            SMALLINT NOT NULL DEFAULT 1,
  address             TEXT,
  address_updated_at  TIMESTAMPTZ,
  nin                 VARCHAR(11),
  nin_slip_url        TEXT,
  utility_bill_url    TEXT,
  tier_upgrade_status kyc_status,          -- pending/approved/rejected for whichever tier request is in flight
  tier_upgrade_notes  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_bvn ON users(bvn);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_kyc_tier ON users(kyc_tier);

-- Safe to re-run against a database created before these columns existed
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_tier SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nin VARCHAR(11);
ALTER TABLE users ADD COLUMN IF NOT EXISTS nin_slip_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utility_bill_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_upgrade_status kyc_status;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_upgrade_notes TEXT;

-- ---------------------------------------------------------------------------
-- ADMIN USERS (separate table from `users` for strict privilege separation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      VARCHAR(150) NOT NULL,
  email          VARCHAR(150) UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  role           admin_role NOT NULL DEFAULT 'support',
  status         admin_status NOT NULL DEFAULT 'active',
  two_fa_enabled BOOLEAN NOT NULL DEFAULT true,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- WALLETS  (one primary NGN wallet per user; extensible to multi-currency)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id        VARCHAR(20) UNIQUE NOT NULL,   -- human readable e.g. KP-0001-2345
  virtual_account  VARCHAR(10),                    -- 10-digit NUBAN-style virtual account
  virtual_bank     VARCHAR(100),
  currency         VARCHAR(3) NOT NULL DEFAULT 'NGN',
  balance          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_frozen        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_wallet_id ON wallets(wallet_id);

-- ---------------------------------------------------------------------------
-- VIRTUAL ACCOUNTS AUDIT (records from whichever provider issued it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS virtual_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  provider            VARCHAR(20) NOT NULL,   -- flutterwave | paystack
  provider_ref        VARCHAR(150),
  account_number      VARCHAR(10) NOT NULL,
  bank_name           VARCHAR(100) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- DEVICES / SESSIONS (used to determine online/offline + refresh tokens)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         VARCHAR(100) NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  user_agent        TEXT,
  ip_address        VARCHAR(64),
  is_online         BOOLEAN NOT NULL DEFAULT true,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked           BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);

-- ---------------------------------------------------------------------------
-- OFFLINE SPENDING TOKENS
-- Issued while device is online; caps how much of the wallet can be spent
-- while offline (OFFLINE_AVAILABLE_PERCENT, default 40%). The remaining
-- 60% is locked and cannot be touched until the device reconnects.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offline_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id           UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  session_id          UUID REFERENCES sessions(id) ON DELETE SET NULL,
  token_hash          TEXT NOT NULL,             -- hash of the signed JWT issued to the client
  balance_snapshot    NUMERIC(18,2) NOT NULL,    -- wallet balance at issuance
  offline_limit       NUMERIC(18,2) NOT NULL,    -- balance_snapshot * OFFLINE_AVAILABLE_PERCENT
  spent_offline       NUMERIC(18,2) NOT NULL DEFAULT 0,
  status              VARCHAR(20) NOT NULL DEFAULT 'active', -- active | synced | expired | revoked
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  synced_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_offline_tokens_wallet ON offline_tokens(wallet_id);

-- ---------------------------------------------------------------------------
-- OFFLINE TRANSACTION QUEUE
-- Transactions created on-device while offline (wallet-to-wallet only).
-- Synced + settled once connectivity returns.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offline_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offline_token_id    UUID NOT NULL REFERENCES offline_tokens(id) ON DELETE CASCADE,
  sender_wallet_id    UUID NOT NULL REFERENCES wallets(id),
  recipient_wallet_id UUID NOT NULL REFERENCES wallets(id),
  amount              NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  narration           TEXT,
  idempotency_key     VARCHAR(100) UNIQUE NOT NULL,
  device_created_at   TIMESTAMPTZ NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending_sync', -- pending_sync | settled | rejected
  rejection_reason    TEXT,
  synced_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- TRANSACTIONS (single ledger for all money movement, online + settled offline)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(40) UNIQUE NOT NULL,
  wallet_id           UUID NOT NULL REFERENCES wallets(id),
  type                txn_type NOT NULL,
  direction           txn_direction NOT NULL,
  amount              NUMERIC(18,2) NOT NULL,
  fee                 NUMERIC(18,2) NOT NULL DEFAULT 0,
  balance_before      NUMERIC(18,2) NOT NULL,
  balance_after       NUMERIC(18,2) NOT NULL,
  status              txn_status NOT NULL DEFAULT 'pending',
  provider            VARCHAR(20),                 -- flutterwave | paystack | internal
  provider_reference  VARCHAR(150),
  counterparty_name   VARCHAR(150),
  counterparty_bank   VARCHAR(100),
  counterparty_number VARCHAR(30),
  narration           TEXT,
  meta                JSONB DEFAULT '{}'::jsonb,
  offline_queue_id    UUID REFERENCES offline_queue(id),
  reversed_txn_id     UUID REFERENCES transactions(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_txn_wallet ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_txn_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions(status);

-- ---------------------------------------------------------------------------
-- FEE CONFIGURATION (admin-adjustable, defaults match business spec)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(50) UNIQUE NOT NULL,  -- e.g. DEPOSIT_BELOW_1000
  label         VARCHAR(150) NOT NULL,
  txn_type      VARCHAR(50) NOT NULL,
  min_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_amount    NUMERIC(18,2),                 -- null = no upper bound
  fee_type      VARCHAR(10) NOT NULL DEFAULT 'flat', -- flat | percentage
  fee_value     NUMERIC(18,2) NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  updated_by    UUID REFERENCES admin_users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- ACCOUNT ACTIONS (block / freeze / suspend / delete / reverse — reversible audit trail)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action        account_action_type NOT NULL,
  reason        TEXT,
  performed_by  UUID NOT NULL REFERENCES admin_users(id),
  reversed      BOOLEAN NOT NULL DEFAULT false,
  reversed_by   UUID REFERENCES admin_users(id),
  reversed_at   TIMESTAMPTZ,
  target_txn_id UUID REFERENCES transactions(id), -- populated when action = 'reverse'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_actions_user ON account_actions(user_id);

-- ---------------------------------------------------------------------------
-- OTPS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  channel       VARCHAR(10) NOT NULL DEFAULT 'email', -- email | sms
  destination   VARCHAR(150) NOT NULL,
  code_hash     TEXT NOT NULL,
  purpose       otp_purpose NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  consumed      BOOLEAN NOT NULL DEFAULT false,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_user ON otps(user_id);

-- ---------------------------------------------------------------------------
-- BANKS (Nigerian + international bank directory used for transfer forms)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banks (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(150) NOT NULL,
  code      VARCHAR(20) NOT NULL,
  country   VARCHAR(60) NOT NULL DEFAULT 'Nigeria',
  provider_supported VARCHAR(20)[] DEFAULT ARRAY['flutterwave','paystack']
);

-- ---------------------------------------------------------------------------
-- AUDIT LOGS (every sensitive admin + system action)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   VARCHAR(20) NOT NULL, -- admin | user | system
  actor_id     UUID,
  action       VARCHAR(100) NOT NULL,
  target_type  VARCHAR(50),
  target_id    UUID,
  meta         JSONB DEFAULT '{}'::jsonb,
  ip_address   VARCHAR(64),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- ---------------------------------------------------------------------------
-- SUPPORT TICKETS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  subject       VARCHAR(200) NOT NULL,
  message       TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'open', -- open | in_progress | resolved | closed
  assigned_to   UUID REFERENCES admin_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_replies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type  VARCHAR(10) NOT NULL, -- user | admin
  author_id    UUID NOT NULL,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- FRAUD MONITORING
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE fraud_alert_status AS ENUM ('open', 'reviewing', 'resolved', 'false_positive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
  rule_code       VARCHAR(60) NOT NULL,   -- e.g. LARGE_AMOUNT, VELOCITY, NEW_DEVICE_HIGH_VALUE
  severity        VARCHAR(10) NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  reason          TEXT NOT NULL,
  status          fraud_alert_status NOT NULL DEFAULT 'open',
  action_taken    VARCHAR(30),             -- none | froze_wallet | blocked_user | reversed_txn | dismissed
  notes           TEXT,
  flagged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by     UUID REFERENCES admin_users(id),
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fraud_alerts_user ON fraud_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status ON fraud_alerts(status);

-- ---------------------------------------------------------------------------
-- ACCOUNT RECOVERY (password / PIN / device-lockout self-recovery requests)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE recovery_status AS ENUM ('pending', 'approved', 'rejected', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recovery_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           VARCHAR(30) NOT NULL,  -- password_reset | pin_reset | device_change | account_lockout
  reason         TEXT,
  status         recovery_status NOT NULL DEFAULT 'pending',
  handled_by     UUID REFERENCES admin_users(id),
  handled_at     TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_requests(status);

-- ---------------------------------------------------------------------------
-- INTERNAL ADMIN NOTIFICATIONS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(150) NOT NULL,
  message       TEXT NOT NULL,
  severity      VARCHAR(10) NOT NULL DEFAULT 'info', -- info | warning | critical
  target_role   admin_role,                            -- null = visible to every admin role
  related_type  VARCHAR(50),
  related_id    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  admin_id        UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, admin_id)
);

-- ---------------------------------------------------------------------------
-- PLATFORM SETTINGS (super-admin adjustable policies: limits, tier rules, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key         VARCHAR(80) PRIMARY KEY,
  value       JSONB NOT NULL,
  label       VARCHAR(150) NOT NULL,
  updated_by  UUID REFERENCES admin_users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value, label) VALUES
  ('withdrawal_limit_tier1', '{"daily": 50000, "monthly": 200000}', 'Tier 1 withdrawal limit (₦)'),
  ('withdrawal_limit_tier2', '{"daily": 500000, "monthly": 3000000}', 'Tier 2 withdrawal limit (₦)'),
  ('withdrawal_limit_tier3', '{"daily": 5000000, "monthly": 50000000}', 'Tier 3 withdrawal limit (₦)'),
  ('tier_requirements', '{"tier1": "BVN + face match (default at signup)", "tier2": "Address + NIN slip", "tier3": "Passport + utility bill matching the tier-2 address"}', 'KYC tier requirements'),
  ('offline_available_percent', '{"percent": 40}', 'Percentage of balance spendable offline')
ON CONFLICT (key) DO NOTHING;
