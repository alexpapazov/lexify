-- =============================================================================
-- 005_folders.sql
-- Infinite-nesting folder tree for the Library.
-- Self-referential parent_id: null = root level.
-- Also adds is_pinned to decks (for the "Pinned decks" section)
-- and folder_id so each deck can live inside a folder.
-- =============================================================================

CREATE TABLE IF NOT EXISTS folders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  parent_id  UUID REFERENCES folders(id) ON DELETE CASCADE,
  -- parent_id NULL = root-level folder
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX folders_owner_parent_idx ON folders(owner_id, parent_id);

CREATE TRIGGER folders_updated_at
  BEFORE UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "folders: owner only"
  ON folders FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- Add folder membership and pinned flag to decks
ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
