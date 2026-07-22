-- ============================================================================
-- Security Settings screen (Transfer Protection, Enable Biometrics, Google
-- 2FA for Withdrawals, Email 2FA for Withdrawals, Passcode). See
-- schema.sql for the canonical definition used on fresh installs — this
-- migration brings existing databases up to the same shape.
--
-- app_lock_pin_hash (the device-unlock passcode) already existed for the
-- offline app-lock feature — "Passcode" in Security Settings reuses it
-- rather than introducing a second PIN, so no new column is needed for that
-- one.
-- ============================================================================

-- Requires OTP/2FA verification before ANY online transfer, regardless of
-- amount. When off, only transfers over the large-transfer threshold
-- (LARGE_TRANSFER_OTP_THRESHOLD, see config/env.js) require it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS transfer_protection_enabled BOOLEAN NOT NULL DEFAULT false;

-- Device-local biometric unlock/approval (Face ID / fingerprint). The actual
-- biometric check happens on-device (native Face ID / Android BiometricPrompt,
-- or WebAuthn platform authenticator on web) and never touches this backend
-- with biometric data — this flag just records the user's preference so it
-- can sync across their devices and be reflected on this Security Settings
-- screen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS biometrics_enabled BOOLEAN NOT NULL DEFAULT false;

-- Google Authenticator-compatible TOTP (RFC 6238), used to gate large/online
-- withdrawals. Secret is AES-256-GCM encrypted at rest (see utils/encryption.js),
-- same pattern as BVN/NIN. Only set once the user has confirmed a code during
-- setup (google2fa_enabled flips to true only after that confirmation).
ALTER TABLE users ADD COLUMN IF NOT EXISTS google2fa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google2fa_secret_encrypted TEXT;

-- Email OTP specifically scoped to withdrawals/transfers (distinct from the
-- existing `two_fa_enabled`, which gates login). Bypassed automatically for
-- queued offline transfers since email delivery requires network — enforced
-- only on the online transfer endpoints (sendToBank / sendInApp).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email2fa_withdrawals_enabled BOOLEAN NOT NULL DEFAULT false;
