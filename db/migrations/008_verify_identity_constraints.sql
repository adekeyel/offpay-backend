-- ============================================================================
-- Safety net for db/migrations/003_reactivatable_identity_fields.sql.
--
-- If, for any reason, 003 never actually ran against this database (a
-- failed deploy step, a migrations table that was manually seeded/edited,
-- restoring an old backup, etc.), the OLD hard UNIQUE constraint on
-- users.email and/or users.phone can still be sitting on the table. When
-- that happens:
--   - register()'s own duplicate check (auth.controller.js) correctly
--     excludes deleted accounts and finds no match, so it does NOT show
--     its friendly "An account already exists" message...
--   - ...but the subsequent INSERT still fails against the old constraint,
--     which does not know about `status`, producing a confusing raw
--     duplicate-key error instead (now caught and surfaced clearly by
--     auth.controller.js's register(), see the try/catch added there).
--
-- This migration is idempotent and safe to run on a database where 003
-- already applied correctly (every branch below is a no-op in that case).
-- It repeats 003's constraint-drop logic and re-asserts the two partial
-- unique indexes so the schema converges to the correct state regardless
-- of what happened before.
-- ============================================================================

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique_active ON users(email) WHERE status != 'deleted';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique_active ON users(phone) WHERE status != 'deleted';
