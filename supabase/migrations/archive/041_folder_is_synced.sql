-- Migration 041: mark auto-managed sync folders as undeletable/unrenamable
--
-- is_synced = true on a folder means it was created by the language sync
-- system and must not be renamed or deleted by the user. The app hides the
-- "Delete folder" button and blocks inline rename for these folders.
-- Currently used for:
--   "SYNCED VOCABULARY"   (root sync folder per destination language pair)
--   "Spanish / English"   (source-pair subfolder inside SYNCED VOCABULARY)

ALTER TABLE folders ADD COLUMN IF NOT EXISTS is_synced BOOLEAN NOT NULL DEFAULT false;
