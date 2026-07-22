-- "Stop at daily goal": cap new-card intake so a deck never introduces enough to graduate past the
-- language's daily goal. Per-deck opt-in, default off (existing behaviour unchanged).
ALTER TABLE user_deck_preferences
  ADD COLUMN IF NOT EXISTS cap_new_to_goal BOOLEAN NOT NULL DEFAULT FALSE;
