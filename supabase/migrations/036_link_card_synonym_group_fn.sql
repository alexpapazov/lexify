-- Migration 036: RPC to set synonym_group_id on a card
-- Updating cards.synonym_group_id via the client hits the cards UPDATE RLS policy.
-- A SECURITY DEFINER function bypasses RLS. We read the caller's user ID from
-- the JWT claim directly (auth.uid() may return NULL in SECURITY DEFINER context).

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
  -- Read user ID from JWT claim (same as auth.uid() but reliable in SECURITY DEFINER)
  v_user_id := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE cards
  SET synonym_group_id = p_synonym_group_id
  WHERE id = p_card_id
    AND owner_id = v_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Card not found or not owned by current user';
  END IF;
END;
$$;

-- Allow authenticated users to call this function
GRANT EXECUTE ON FUNCTION link_card_to_synonym_group(UUID, UUID) TO authenticated;
