-- 069_typed_strictness_levels.sql
--
-- Upgrades per-category typed-answer strictness from a boolean (strict/lenient)
-- to a three-way level, stored as TEXT on the forward_typed user_scheduler_params row:
--   'penalize' — scheduling penalty + retype required (old "strict")
--   'retype'   — no penalty, retype required          (old "lenient")
--   'accept'   — no penalty, no retype; marked correct with an "X error" note (new)
--
-- Backfills from the existing boolean columns: strict → 'penalize', lenient → 'retype'.
-- The old boolean columns (066) are left in place (unused) for safety.

ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS spelling_mode TEXT NOT NULL DEFAULT 'penalize'
    CHECK (spelling_mode IN ('penalize', 'retype', 'accept')),
  ADD COLUMN IF NOT EXISTS accents_mode  TEXT NOT NULL DEFAULT 'penalize'
    CHECK (accents_mode  IN ('penalize', 'retype', 'accept')),
  ADD COLUMN IF NOT EXISTS articles_mode TEXT NOT NULL DEFAULT 'penalize'
    CHECK (articles_mode IN ('penalize', 'retype', 'accept'));

-- Backfill from the legacy booleans where present.
UPDATE user_scheduler_params
SET spelling_mode = CASE WHEN strict_spelling IS FALSE THEN 'retype' ELSE 'penalize' END,
    accents_mode  = CASE WHEN strict_accents  IS FALSE THEN 'retype' ELSE 'penalize' END,
    articles_mode = CASE WHEN strict_articles IS FALSE THEN 'retype' ELSE 'penalize' END
WHERE answer_field = 'forward_typed';
