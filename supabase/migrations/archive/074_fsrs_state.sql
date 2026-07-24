-- 074_fsrs_state.sql
--
-- FSRS Due Now scheduler (Stage 2/3). Per (card, direction) review row gains the
-- FSRS memory state — difficulty + stability — plus the relearn-gate counters.
-- Difficulty/stability start NULL (seeded at graduation, or by the migration that
-- estimates them for already-graduated cards).

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS difficulty   real,
  ADD COLUMN IF NOT EXISTS stability    real,
  ADD COLUMN IF NOT EXISTS relearning   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS good_streak  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS again_streak integer NOT NULL DEFAULT 0;
