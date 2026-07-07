-- 067_review_events_language.sql
--
-- Denormalize the card's language pair onto review_events. Calibration reads
-- review_events to compute retention, but the table had no language column, so
-- every language's constants were being calibrated from ONE global pool of the
-- user's reviews (all languages averaged together). These columns let the
-- calibrator filter reviews per language pair so each language calibrates on its
-- own data.

ALTER TABLE review_events
  ADD COLUMN IF NOT EXISTS source_language TEXT,
  ADD COLUMN IF NOT EXISTS target_language TEXT;

-- Backfill from each card's deck (any one deck when a card is shared across decks).
UPDATE review_events re SET
  source_language = d.source_language,
  target_language = d.target_language
FROM deck_cards dc
JOIN decks d ON d.id = dc.deck_id
WHERE dc.card_id = re.card_id
  AND re.source_language IS NULL;

CREATE INDEX IF NOT EXISTS review_events_lang_due_idx
  ON review_events(user_id, source_language, target_language, review_mode, review_direction, was_typed);
