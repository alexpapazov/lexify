-- 132_media_ratings.sql — per-lemma rating state on media entries (Extraction Engine Stage B).
--
-- The processed entry is a WORKLIST rated page by page, at any granularity, resumable. This
-- column records what each item got, keyed by its normalized lemma (phrases by their text):
--   'dontknow' | 'short' | 'long' | 'ignored' | 'penalized' | 'dismissed' | 'credited'
-- An item with a rating never reappears in the worklist; cross-page dedupe means a lemma is
-- rated ONCE per entry, on the earliest page it occurs.

ALTER TABLE media_entries ADD COLUMN IF NOT EXISTS ratings jsonb NOT NULL DEFAULT '{}'::jsonb;
