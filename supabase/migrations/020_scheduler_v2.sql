-- Migration 020: long-term remembering algorithm v2.
--
-- Brings card_states / review_events in line with the finalized retention
-- algorithm spec:
--  - separates the "ideal" memory-state interval (interval_days, unchanged)
--    from the actual calendar-scheduled gap (scheduled_interval_days), used
--    to determine elective/due timing from due_at rather than interval_days.
--  - adds the 10-minute "Again" relearn loop (relearning_step,
--    pending_interval_days).
--  - adds typed-vs-self-graded production tracking (typed_accuracy_window,
--    typed_review_count, last_typed_review_at, forced_typed_remaining,
--    graduated_at).
--  - adds a running interval history for analytics/debugging.
--  - adds review_mode / was_typed to review_events.

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS scheduled_interval_days numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graduated_at timestamptz,
  ADD COLUMN IF NOT EXISTS relearning_step integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_interval_days numeric,
  ADD COLUMN IF NOT EXISTS typed_accuracy_window jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS typed_review_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_typed_review_at timestamptz,
  ADD COLUMN IF NOT EXISTS forced_typed_remaining integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interval_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: best-available approximations for rows that predate this migration.
UPDATE card_states
  SET scheduled_interval_days = interval_days
  WHERE graduated = true AND scheduled_interval_days = 0;

UPDATE card_states
  SET graduated_at = last_reviewed_at
  WHERE graduated = true AND graduated_at IS NULL;

ALTER TABLE review_events
  ADD COLUMN IF NOT EXISTS review_mode text,
  ADD COLUMN IF NOT EXISTS was_typed boolean;
