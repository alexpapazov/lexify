-- Migration 045: Add fast-track graduated review fields to card_states.
-- Fast-tracked cards (import-known) are created as graduated=true with
-- boosted multipliers that decay toward normal as wrong answers accumulate.

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS accelerated_mode         TEXT    NOT NULL DEFAULT 'none'
    CHECK (accelerated_mode IN ('none', 'import_known')),
  ADD COLUMN IF NOT EXISTS accelerated_locked       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accelerated_wrong_streak INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accelerated_penalty      INTEGER NOT NULL DEFAULT 0;
