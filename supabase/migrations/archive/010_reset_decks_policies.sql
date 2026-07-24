-- Migration 010: reset ALL row-level security policies on `decks`.
--
-- Migration 009 recreated "decks: owner update" with an explicit
-- USING/WITH CHECK, but that turned out to be functionally identical to
-- the original policy (Postgres defaults WITH CHECK to USING for UPDATE
-- policies when omitted) — so it didn't fix the soft-delete error.
--
-- The soft-delete error ("new row violates row-level security policy for
-- table \"decks\"") happens specifically when setting deleted_at to a
-- non-null value, but NOT on other deck updates (e.g. changing languages).
-- The most likely explanation is a stray RESTRICTIVE (or extra permissive)
-- policy on `decks` — added ad-hoc via the SQL editor in an earlier
-- session — whose check clause requires `deleted_at IS NULL`, which the
-- post-update row violates.
--
-- Rather than guess at that policy's name, drop EVERY policy currently on
-- `decks` and recreate exactly the canonical set from 001_initial.sql
-- (with 009's explicit WITH CHECK on the update policy).
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN SELECT polname FROM pg_policy WHERE polrelid = 'decks'::regclass LOOP
    EXECUTE format('DROP POLICY %I ON decks', pol.polname);
  END LOOP;
END $$;

CREATE POLICY "decks: owner select"  ON decks FOR SELECT USING (auth.uid() = owner_id AND deleted_at IS NULL);
CREATE POLICY "decks: public select" ON decks FOR SELECT USING (is_public = TRUE AND deleted_at IS NULL);
CREATE POLICY "decks: owner insert"  ON decks FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "decks: owner update"  ON decks
  FOR UPDATE
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);
