-- Migration 034: synonym groups and lexical item extensions
-- Adds the synonym_groups table and extends cards with synonym/register fields.
-- NOTE: cards columns are added BEFORE the RLS policies that reference them.

-- ── 1. synonym_groups table (no FK from cards yet) ────────────────────────────
CREATE TABLE IF NOT EXISTS synonym_groups (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gloss          TEXT        NOT NULL,
  gloss_language TEXT        NOT NULL,
  item_language  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE synonym_groups ENABLE ROW LEVEL SECURITY;

-- ── 2. Extend cards table (creates synonym_group_id column) ───────────────────
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS synonym_group_id            UUID    REFERENCES synonym_groups(id),
  ADD COLUMN IF NOT EXISTS register                    TEXT    CHECK (register IN ('neutral','informal','formal','regional','vulgar')),
  ADD COLUMN IF NOT EXISTS region                      TEXT,
  ADD COLUMN IF NOT EXISTS accepted_front_alternatives JSONB,
  ADD COLUMN IF NOT EXISTS accepted_back_alternatives  JSONB;

-- ── 3. RLS policies (cards.synonym_group_id now exists) ───────────────────────
-- Drop first so re-runs are safe.
DROP POLICY IF EXISTS "owner_read_synonym_groups"   ON synonym_groups;
DROP POLICY IF EXISTS "owner_insert_synonym_groups" ON synonym_groups;
DROP POLICY IF EXISTS "owner_update_synonym_groups" ON synonym_groups;

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

CREATE POLICY "owner_insert_synonym_groups"
ON synonym_groups FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "owner_update_synonym_groups"
ON synonym_groups FOR UPDATE USING (
  id IN (
    SELECT DISTINCT synonym_group_id
    FROM cards
    WHERE owner_id = auth.uid()
      AND synonym_group_id IS NOT NULL
  )
);

-- ── 4. Index for grouping lookups ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS cards_synonym_group_id_idx
  ON cards(synonym_group_id)
  WHERE synonym_group_id IS NOT NULL;

-- ── 5. updated_at trigger for synonym_groups ──────────────────────────────────
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
