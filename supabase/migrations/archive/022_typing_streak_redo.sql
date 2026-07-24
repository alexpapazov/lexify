-- Migration 022: typing-mistake streak → multiple-choice redo.
--
-- Pre-graduation bookkeeping for engine/pipeline.ts: tracks consecutive wrong
-- answers on a typing step (reset by a correct typing answer), and how many
-- times that streak has hit 3. Every 3rd such cycle sends the card back to
-- redo both recognition (multiple-choice) steps before resuming typing.

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS typing_mistake_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS typing_fail_cycles integer NOT NULL DEFAULT 0;
