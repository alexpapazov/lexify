-- Migration 038: SECURITY DEFINER function for soft-deleting a card.
--
-- The cards SELECT policy has `deleted_at IS NULL` in its USING clause.
-- After a client-side UPDATE that sets deleted_at, PostgREST re-checks the
-- SELECT policy on the resulting row, which now fails because deleted_at is
-- set — raising "new row violates row-level security policy for table cards".
-- (The exact same issue was fixed for decks in migration 009.)
--
-- Fix: move the soft-delete into a SECURITY DEFINER function that runs as
-- the postgres role (bypassing RLS) but verifies ownership via the JWT sub
-- before touching anything.

CREATE OR REPLACE FUNCTION soft_delete_card(p_card_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := coalesce(
    nullif(current_setting('request.jwt.claim.sub',  true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE cards
    SET deleted_at = NOW()
    WHERE id = p_card_id
      AND owner_id = v_user_id
      AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Card not found or not owned by current user';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION soft_delete_card(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
