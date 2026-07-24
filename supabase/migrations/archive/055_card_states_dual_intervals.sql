-- Add review_direction first (with default so existing rows are backfilled).
ALTER TABLE card_states
  ADD COLUMN review_direction TEXT NOT NULL DEFAULT 'forward';

-- Add dual interval columns (nullable — null until the respective track activates).
ALTER TABLE card_states
  ADD COLUMN typed_interval_days  REAL,
  ADD COLUMN typed_due_at         TIMESTAMPTZ,
  ADD COLUMN recall_interval_days REAL,
  ADD COLUMN recall_due_at        TIMESTAMPTZ;

-- Update primary key to include review_direction.
-- Drop any unique index on (user_id, card_id) that is NOT the primary key first:
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'card_states';
-- then drop with: DROP INDEX IF EXISTS <indexname>;
ALTER TABLE card_states DROP CONSTRAINT card_states_pkey;
ALTER TABLE card_states ADD PRIMARY KEY (user_id, card_id, review_direction);
