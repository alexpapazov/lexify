-- 111_practice_slider.sql — Practice Mode's "% of words from my graduated vocabulary" setting.
--
-- Stored PER LANGUAGE PAIR, not globally: a large Spanish library can demand 90% known words while
-- a young French one has to sit much lower to produce anything at all. NULL = never set, and the UI
-- falls back to its own default rather than baking one into the schema.
--
-- The value is a target the generator is scored against, not a hard guarantee — see
-- features/Practice Mode.md.

ALTER TABLE language_pairs ADD COLUMN IF NOT EXISTS practice_graduated_pct INTEGER;
