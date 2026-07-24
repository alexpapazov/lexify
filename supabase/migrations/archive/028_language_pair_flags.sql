-- Add per-pair custom flag emoji to language_pairs.
-- NULL = use the language's default flag from lib/languages.ts.
ALTER TABLE language_pairs ADD COLUMN IF NOT EXISTS flag TEXT;
