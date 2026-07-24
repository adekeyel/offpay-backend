-- ============================================================================
-- Support help-center content: the category tiles at the top of the Support
-- page (e.g. "Transaction Dispute", "Report Scam") and the FAQ list, both
-- editable by admin rather than hardcoded in the app, so content changes
-- don't require a native app release.
-- ============================================================================

CREATE TABLE IF NOT EXISTS support_topics (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  icon             VARCHAR(10) NOT NULL DEFAULT '❓',       -- a single emoji, shown on the tile
  label            VARCHAR(60) NOT NULL,
  prefill_subject  VARCHAR(200),                             -- pre-fills the ticket form's subject when tapped
  prefill_message  TEXT,                                     -- optional starter text for the ticket message
  sort_order       INT NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_faqs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category     VARCHAR(60) NOT NULL DEFAULT 'General',       -- free-text tab name, e.g. "Hot Issues", "Transaction", "Account"
  question     VARCHAR(300) NOT NULL,
  answer       TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_faqs_category ON support_faqs(category);

-- Starter content so the page isn't empty on first deploy — admin can edit
-- or delete any of these from the admin dashboard afterward.
INSERT INTO support_topics (icon, label, prefill_subject, sort_order) VALUES
  ('💳', 'Transaction Dispute', 'Transaction dispute', 1),
  ('↩️', 'Erroneous Transfer', 'Erroneous transfer', 2),
  ('📈', 'Account Limits', 'Question about my account limits', 3),
  ('🔒', 'Password & PIN', 'Password / PIN issue', 4),
  ('📱', 'Phone Number Change', 'Request to change my phone number', 5),
  ('🚨', 'Report Scam', 'Reporting a scam', 6)
ON CONFLICT DO NOTHING;

INSERT INTO support_faqs (category, question, answer, sort_order) VALUES
  ('Hot Issues', 'I was debited for a failed transaction', 'Failed transactions are usually reversed automatically within 24 hours. If it has been longer than that, open a support ticket with the transaction reference and we''ll investigate.', 1),
  ('Hot Issues', 'Why is my transfer still pending?', 'Bank transfers can take a few minutes to confirm on the receiving bank''s side. If a transfer has been pending for more than 30 minutes, contact support with the reference number.', 2),
  ('Transaction', 'A transfer was successful but not credited', 'This can happen if the receiving bank delays confirmation. Share the transaction reference with support so we can trace and reconcile it.', 1),
  ('Account', 'How do I increase my account tier/limit?', 'Go to Me > Upgrade Tier and complete the next verification level. Higher tiers unlock higher daily transaction limits.', 1)
ON CONFLICT DO NOTHING;
