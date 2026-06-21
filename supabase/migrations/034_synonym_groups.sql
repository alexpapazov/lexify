-- Migration 034: synonym groups and lexical item extensions
-- Adds the synonym_groups table and extends cards with synonym/register fields.

-- ── 1. synonym_groups table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS synonym_groups (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gloss         TEXT        NOT NULL,   -- shared native-language meaning, e.g. "pig"
  gloss_language TEXT       NOT NULL,   -- language of the gloss, e.g. "en"
  item_language  TEXT       NOT NULL,   -- language of the items, e.g. "es"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE synonym_groups ENABLE ROW LEVEL SECURITY;

-- Users can read synonym groups for cards they own.
CREATE POLICY "owner_read_synonym_groups"
ON synonym_groups FOR SELECT USING (
  id IN (
    SELECT DISTINCT synonym_group_id
    FROM cards
    WHERE owner_id = auth.uid()
      AND synonym_group_id IS NOT NULL
      AND deleted_at IS NULL
  )
);

-- Users can insert synonym groups (they'll link their own cards to it).
CREATE POLICY "owner_insert_synonym_groups"
ON synonym_groups FOR INSERT WITH CHECK (true);

-- Users can update synonym groups for their own cards.
CREATE POLICY "owner_update_synonym_groups"
ON synonym_groups FOR UPDATE USING (
  id IN (
    SELECT DISTINCT synonym_group_id
    FROM cards
    WHERE owner_id = auth.uid()
      AND synonym_group_id IS NOT NULL
  )
);

-- ── 2. Extend cards table ──────────────────────────────────────────────────────
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS synonym_group_id          UUID    REFERENCES synonym_groups(id),
  ADD COLUMN IF NOT EXISTS register                  TEXT    CHECK (register IN ('neutral','informal','formal','regional','vulgar')),
  ADD COLUMN IF NOT EXISTS region                    TEXT,
  ADD COLUMN IF NOT EXISTS accepted_front_alternatives JSONB,  -- string[]
  ADD COLUMN IF NOT EXISTS accepted_back_alternatives  JSONB;  -- string[]

-- Index for grouping lookups.
CREATE INDEX IF NOT EXISTS cards_synonym_group_id_idx
  ON cards(synonym_group_id)
  WHERE synonym_group_id IS NOT NULL;

-- ── 3. updated_at trigger for synonym_groups ───────────────────────────────────
CREATE OR REPLACE FUNCTION update_synonym_groups_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS synonym_groups_updated_at ON synonym_groups;
CREATE TRIGGER synonym_groups_updated_at
  BEFORE UPDATE ON synonym_groups
  FOR EACH ROW EXECUTE FUNCTION update_synonym_groups_updated_at();
