-- Bug fix: folders need an explicit language pair so they don't bleed
-- into every language's library view when they're empty.
-- Also: sync no longer creates folders — decks land directly at root
-- with the sync date as their name, so make folder refs nullable.

ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS source_language TEXT,
  ADD COLUMN IF NOT EXISTS target_language TEXT;

-- Make folder FK columns nullable so rows without folders can exist.
ALTER TABLE language_sync_state
  ALTER COLUMN root_folder_id DROP NOT NULL,
  ALTER COLUMN sub_folder_id  DROP NOT NULL;

-- Track which date the current sync deck was created for (reused intra-day).
ALTER TABLE language_sync_state
  ADD COLUMN IF NOT EXISTS sync_date TEXT;
