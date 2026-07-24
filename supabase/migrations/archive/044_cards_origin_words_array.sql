-- Migration 044: Replace single-value sync origin columns with arrays so a
-- synced card can track multiple source languages (e.g. "rouge" from both
-- Spanish "rojo" and Italian "rosso"). The old columns are kept for backwards
-- compatibility and can be removed in a future cleanup migration.

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS origin_words          TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS synced_from_languages TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: convert existing single-value rows into the new array format.
UPDATE cards
SET
  origin_words          = ARRAY[origin_word],
  synced_from_languages = ARRAY[synced_from_language]
WHERE origin_word IS NOT NULL
  AND synced_from_language IS NOT NULL;
