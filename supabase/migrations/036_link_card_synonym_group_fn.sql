-- Migration 036: RPC to set synonym_group_id on a card
-- Updating cards.synonym_group_id via the client hits the cards UPDATE RLS policy.
-- A SECURITY DEFINER function bypasses that while still enforcing ownership.

CREATE OR REPLACE FUNCTION link_card_to_synonym_group(
  p_card_id          UUID,
  p_synonym_group_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE cards
  SET synonym_group_id = p_synonym_group_id
  WHERE id = p_card_id
    AND owner_id = auth.uid()
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Card not found or not owned by current user';
  END IF;
END;
$$;
