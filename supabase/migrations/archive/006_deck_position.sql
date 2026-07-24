-- Migration 006: add position column to decks for drag-and-drop ordering

ALTER TABLE decks ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

-- Back-fill existing decks with their current natural order per owner
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY owner_id ORDER BY created_at) - 1 AS rn
  FROM decks
  WHERE deleted_at IS NULL
)
UPDATE decks SET position = ranked.rn
FROM ranked
WHERE decks.id = ranked.id;
