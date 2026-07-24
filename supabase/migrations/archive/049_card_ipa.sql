-- Add IPA transcription column to cards.
-- Stores AI-generated International Phonetic Alphabet transcription for card.front
-- (the source/learned language text). Null until generated via /api/ipa.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS ipa TEXT;
