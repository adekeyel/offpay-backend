-- Allows email, phone, and BVN to be reused once an old account has been
-- deleted, and relaxes BVN to allow multiple accounts (subject to the
-- Tier-3 rule enforced in application code — see auth.controller.js).

-- Drop the old hard-unique constraints on email/phone (Postgres' default
-- naming for an inline `UNIQUE` column constraint is `<table>_<column>_key`).
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
  WHERE rel.relname = 'users' AND con.contype = 'u' AND att.attname = 'email';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', cname);
  END IF;
END $$;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
  WHERE rel.relname = 'users' AND con.contype = 'u' AND att.attname = 'phone';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- Drop the old strict BVN uniqueness (may not exist yet under this name on
-- every environment, hence IF EXISTS).
DROP INDEX IF EXISTS idx_users_bvn_hash_unique;
CREATE INDEX IF NOT EXISTS idx_users_bvn_hash ON users(bvn_hash);

-- Add the new partial-unique replacements: unique only among non-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique_active ON users(email) WHERE status != 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique_active ON users(phone) WHERE status != 'deleted';
