-- Migration 050: Clean up card_states (and related rows) when a card is soft-deleted.
--
-- Previously soft_delete_card only set cards.deleted_at; card_states rows for
-- deleted cards were left behind, causing the deck-detail stats ("5 Learning")
-- to show ghost counts for cards the user had already deleted.

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

  -- Remove the learning-pipeline state so stats no longer count this card.
  DELETE FROM card_states
    WHERE card_id = p_card_id AND user_id = v_user_id;

  -- Remove any typed-answer overrides for this card.
  DELETE FROM typed_answer_overrides
    WHERE card_id = p_card_id AND user_id = v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION soft_delete_card(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
