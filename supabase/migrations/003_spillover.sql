-- =============================================================================
-- 003_spillover.sql
--
-- Adds spillover_due toggle to profiles (global default) and to
-- user_deck_preferences (per-deck override).
--
-- spillover_due = false (default):
--   In-pipeline cards from PREVIOUS days count against today's new-card budget.
--   Total active cards stays at daily_new_cards.
--
-- spillover_due = true:
--   Previous-day in-pipeline cards are NOT subtracted from today's budget.
--   Backlog accumulates — you'll see more cards each day you fall behind.
-- =============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS spillover_due BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE user_deck_preferences
  ADD COLUMN IF NOT EXISTS spillover_due BOOLEAN NOT NULL DEFAULT FALSE;
