-- Migration 033: grading settings v2
-- Renames JSONB keys in decks.grading_settings to the new field names,
-- adds gradingMode, and adds per-card error tracking columns to card_states.

-- ── 1. Convert existing deck grading_settings JSONB ──────────────────────────
-- Only transforms rows that still have the OLD key names (idempotent).
UPDATE decks
SET grading_settings = jsonb_build_object(
  'gradingMode',                 'flexible',
  'ignoreAccents',               COALESCE((grading_settings->>'accentInsensitive')::boolean,       true),
  'ignoreCapitalization',        COALESCE((grading_settings->>'caseInsensitive')::boolean,         true),
  'ignoreMinorTypos',            COALESCE((grading_settings->>'allowOneTypo')::boolean,            false),
  'ignoreDefiniteArticles',      COALESCE((grading_settings->>'articleOptional')::boolean,         false),
  -- Old ignoreParentheticals=true means "parens optional" = requireParentheticalContent=false
  'requireParentheticalContent', NOT COALESCE((grading_settings->>'ignoreParentheticals')::boolean, true),
  'slashAlternativesMode',       CASE
                                   WHEN COALESCE((grading_settings->>'acceptSlashAlternatives')::boolean, true)
                                   THEN 'accept_any'
                                   ELSE 'require_all'
                                 END,
  'commaAlternativesMode',       'split_into_cards'
)
WHERE grading_settings IS NOT NULL
  AND grading_settings ? 'accentInsensitive';   -- only rows with old schema

-- ── 2. Per-card error tracking columns ────────────────────────────────────────
ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS accent_mistake_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS article_mistake_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gender_mistake_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS typo_mistake_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS semantic_mistake_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wrong_synonym_count    INTEGER NOT NULL DEFAULT 0;
