-- ============================================================================
-- Lets db/syncPeyflexProducts.js (or any future provider-catalog sync) safely
-- re-run without creating duplicate plan rows: ON CONFLICT (category,
-- provider, code) DO UPDATE needs this constraint to exist first.
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE vtu_products
    ADD CONSTRAINT vtu_products_category_provider_code_key
    UNIQUE (category, provider, code);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
