-- Migration 011: soft-delete decks via a SECURITY DEFINER function.
--
-- The "decks: owner update" RLS policy (USING/WITH CHECK auth.uid() = owner_id)
-- looks correct, but a direct UPDATE ... SET deleted_at = now() still raises
-- "new row violates row-level security policy for table \"decks\"" even when
-- auth.uid() is set to match owner_id exactly. The root cause of that mismatch
-- hasn't been pinned down, so instead we bypass RLS for this one operation via
-- a SECURITY DEFINER function (runs as the table owner, which RLS doesn't
-- apply to) with an explicit ownership check baked in.
CREATE OR REPLACE FUNCTION soft_delete_deck(p_deck_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE decks
  SET deleted_at = now()
  WHERE id = p_deck_id
    AND owner_id = auth.uid()
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deck not found or not owned by current user';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION soft_delete_deck(uuid) TO authenticated;
