-- ============================================================================
-- Adds the client-facing notifications table (login alerts, app/update
-- announcements, and support-reply alerts shown on the app's Notifications
-- screen). See schema.sql for the canonical definition used on fresh installs
-- — this migration brings existing databases up to the same shape.
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL,
  title         VARCHAR(150) NOT NULL,
  message       TEXT NOT NULL,
  related_type  VARCHAR(50),
  related_id    UUID,
  is_read       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, created_at DESC);
