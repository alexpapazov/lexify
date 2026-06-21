-- Migration 035: add owner_id to synonym_groups and simplify RLS
-- The join-based INSERT policy on synonym_groups was unreliable.
-- All other user-owned tables use owner_id = auth.uid() — do the same here.

ALTER TABLE synonym_groups
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id);

-- Drop whatever policies exist (from partial 034 runs)
DROP POLICY IF EXISTS "owner_read_synonym_groups"   ON synonym_groups;
DROP POLICY IF EXISTS "owner_insert_synonym_groups" ON synonym_groups;
DROP POLICY IF EXISTS "owner_update_synonym_groups" ON synonym_groups;
DROP POLICY IF EXISTS "owner_all_synonym_groups"    ON synonym_groups;

-- Single permissive policy: owner can do everything
CREATE POLICY "owner_all_synonym_groups"
ON synonym_groups
USING     (owner_id = auth.uid())
WITH CHECK(owner_id = auth.uid());
