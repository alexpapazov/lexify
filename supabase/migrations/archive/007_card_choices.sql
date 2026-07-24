-- Migration 007: add cached multiple-choice distractor pools to cards
--
-- `choices` stores AI-generated (or fallback) distractor options per side,
-- generated lazily the first time a card is studied in multiple-choice mode.
-- Shape: { "front": string[], "back": string[] } — does NOT include the
-- correct answer itself, just the pool of wrong options to pick from.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS choices jsonb;
