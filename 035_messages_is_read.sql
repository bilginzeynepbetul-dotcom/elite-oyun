-- Mesaj okundu işaretleme
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_messages_to_unread
  ON messages (to_user_id, is_read, created_at DESC)
  WHERE is_read = FALSE;
