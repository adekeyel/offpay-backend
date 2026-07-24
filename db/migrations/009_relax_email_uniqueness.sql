-- Allows the same email to be reused across multiple OffPay accounts,
-- mirroring how BVN was relaxed in 003_reactivatable_identity_fields.sql.
--
-- A person may now hold more than one OffPay account under the same email
-- AND the same BVN, as long as not every account under that identity sits
-- at the same KYC tier — enforced in application code, see
-- auth.controller.js register(). This index can no longer express that
-- rule (it never could for BVN either), so it's dropped here in favor of
-- the plain, non-unique idx_users_email lookup index that schema.sql
-- already creates.
--
-- Safe to re-run: DROP INDEX IF EXISTS is a no-op if this has already been
-- applied (or never existed) on this database.
DROP INDEX IF EXISTS idx_users_email_unique_active;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
