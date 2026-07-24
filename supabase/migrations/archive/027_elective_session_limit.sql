-- 027_elective_session_limit.sql
--
-- Adds elective_session_limit to user_deck_preferences.
-- Controls how many cards are shown per elective (study-ahead) session batch.
-- NULL = use app default (20). 0 = no cap. Positive integer = cap at that value.

ALTER TABLE user_deck_preferences
  ADD COLUMN IF NOT EXISTS elective_session_limit INTEGER;
