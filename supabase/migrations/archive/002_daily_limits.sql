-- =============================================================================
-- 002_daily_limits.sql
-- Adds per-user daily new-card limits, per-deck overrides, and introduced_date
-- tracking on card_states so sessions can enforce how many NEW cards to show.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Default daily new cards on profiles
-- ---------------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS default_daily_new_cards INTEGER NOT NULL DEFAULT 20;

-- ---------------------------------------------------------------------------
-- 2. user_deck_preferences
--    Stores per-deck daily new-card limits and today-only overrides.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_deck_preferences (
  user_id             UUID    NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  deck_id             UUID    NOT NULL REFERENCES decks(id)      ON DELETE CASCADE,
  -- Persistent daily limit for this deck (inherits profile default if not set)
  daily_new_cards     INTEGER NOT NULL DEFAULT 20,
  -- Temporary one-day override (nulled out after the date passes)
  daily_override      INTEGER,
  daily_override_date DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, deck_id)
);

CREATE TRIGGER user_deck_prefs_updated_at
  BEFORE UPDATE ON user_deck_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE user_deck_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deck_prefs: owner only"
  ON user_deck_preferences FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. introduced_date on card_states
--    Set to today (UTC) the first time a card enters a user's pipeline.
--    Used to count how many NEW cards have been introduced today per deck,
--    so the session knows when to stop adding new cards.
-- ---------------------------------------------------------------------------
ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS introduced_date DATE;
