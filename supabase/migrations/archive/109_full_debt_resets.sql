-- Per-language "reset my debt" for full-debt carryover.
--
-- The debt is DERIVED, never stored: today's goal = base − (graduations − planned) summed since the
-- enable date. So there is no counter to zero — the only way to clear a language's balance is to move
-- the date the sum starts from.
--
-- `goal_full_debt_since` is one date for the whole profile, which can only reset everything at once.
-- This adds a per-pair override: `{"es|en": "2026-07-31"}`. A pair's effective start is the LATER of
-- the two, so a global reset still wins over a stale per-pair entry and neither can resurrect debt the
-- other cleared.
--
-- Keeping it stateless matters: capping or storing the balance would break the 2.5x daily cap, which
-- works precisely because the withheld remainder stays in a recomputed total. See CLAUDE.md.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS goal_full_debt_resets JSONB NOT NULL DEFAULT '{}'::jsonb;
