-- Migration 037: synonym_groups — clean, idempotent replacement for 034/035/036.
-- Safe to run whether those migrations were fully applied, partially applied, or not at all.

-- ── 1. synonym_groups table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS synonym_groups (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  gloss          TEXT        NOT NULL,
  gloss_language TEXT        NOT NULL,
  item_language  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add owner_id (idempotent — IF NOT EXISTS)
ALTER TABLE synonym_groups
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id);

ALTER TABLE synonym_groups ENABLE ROW LEVEL SECURITY;

-- ── 2. Extend cards table ─────────────────────────────────────────────────────
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS synonym_group_id            UUID REFERENCES synonym_groups(id),
  ADD COLUMN IF NOT EXISTS register                    TEXT CHECK (register IN ('neutral','informal','formal','regional','vulgar')),
  ADD COLUMN IF NOT EXISTS region                      TEXT,
  ADD COLUMN IF NOT EXISTS accepted_front_alternatives JSONB,
  ADD COLUMN IF NOT EXISTS accepted_back_alternatives  JSONB;

-- ── 3. RLS on synonym_groups — drop everything and start clean ────────────────
DROP POLICY IF EXISTS "owner_read_synonym_groups"   ON synonym_groups;
DROP POLICY IF EXISTS "owner_insert_synonym_groups" ON synonym_groups;
DROP POLICY IF EXISTS "owner_update_synonym_groups" ON synonym_groups;
DROP POLICY IF EXISTS "owner_all_synonym_groups"    ON synonym_groups;

-- Single simple policy: owner_id = auth.uid() (same pattern as all other tables)
CREATE POLICY "owner_all_synonym_groups"
ON synonym_groups
USING     (owner_id = auth.uid())
WITH CHECK (owner_id = auth.uid());

-- ── 4. Index for grouping lookups ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS cards_synonym_group_id_idx
  ON cards(synonym_group_id)
  WHERE synonym_group_id IS NOT NULL;

-- ── 5. updated_at trigger ─────────────────────────────────────────────────────
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

-- ── 6. SECURITY DEFINER function to set synonym_group_id on a card ────────────
-- Direct UPDATE from the client is blocked by cards RLS (UPDATE policy requires
-- owner_id = auth.uid() on the resulting row, which is satisfied, but PostgREST
-- still enforces it in a way that fails for this specific column update).
-- This function runs as the postgres role (bypassing RLS) but still checks
-- ownership explicitly via the JWT claim.
CREATE OR REPLACE FUNCTION link_card_to_synonym_group(
  p_card_id          UUID,
  p_synonym_group_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Read caller identity from JWT (auth.uid() can return NULL in SECURITY DEFINER)
  v_user_id := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims',    true), '')::jsonb ->> 'sub'
  )::uuid;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE cards
  SET synonym_group_id = p_synonym_group_id
  WHERE id          = p_card_id
    AND owner_id    = v_user_id
    AND deleted_at  IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Card not found or not owned by current user';
  END IF;
END;
$$;

-- Let authenticated users call this function
GRANT EXECUTE ON FUNCTION link_card_to_synonym_group(UUID, UUID) TO authenticated;
