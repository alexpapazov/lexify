-- Migration 040: add sync origin metadata to cards
--
-- Synced cards need to know where they came from so the info panel can
-- display "Synced from: Spanish" and "Origin word: el perro".
--
-- synced_from_language — language code of the source deck's learned language
--                        (e.g. 'es' for Spanish/English → Bulgarian/English sync)
-- origin_word          — the learned-language word from the source card
--                        (card.front of the source card, e.g. "el perro")
--
-- Both are NULL for cards created directly by the user (not synced).

ALTER TABLE cards ADD COLUMN IF NOT EXISTS synced_from_language TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS origin_word          TEXT;
