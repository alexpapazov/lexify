-- Migration 043: backfill is_synced=true on SYNCED VOCABULARY folders created
-- before migration 041 added the column (they defaulted to false and were
-- therefore unprotected from deletion, which caused the duplicate-root bug).

UPDATE folders
SET is_synced = true
WHERE deleted_at IS NULL
  AND (
    name = 'SYNCED VOCABULARY'
    OR parent_id IN (
      SELECT id FROM folders WHERE name = 'SYNCED VOCABULARY' AND deleted_at IS NULL
    )
  );
