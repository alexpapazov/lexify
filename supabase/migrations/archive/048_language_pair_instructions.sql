-- Per-language-pair AI instructions (used as default prompt for word-list generator and translation)
ALTER TABLE language_pairs ADD COLUMN IF NOT EXISTS instructions TEXT DEFAULT NULL;
