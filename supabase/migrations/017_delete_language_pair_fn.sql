-- Migration 017: delete an entire language pairing via a SECURITY DEFINER function.
--
-- "Delete language pairing" permanently removes everything for one
-- source/target direction:
--   - All `cards` owned by the user with this source/target language are
--     hard-deleted. This cascades (ON DELETE CASCADE) to `deck_cards`,
--     `card_states`, `review_events`, and `dismissed_duplicate_pairs`.
--   - All `decks` owned by the user with this source/target language are
--     soft-deleted (consistent with the existing soft_delete_deck flow).
--   - The matching `language_pairs` row is removed.
--
-- `cards` has no FOR DELETE RLS policy (only owner SELECT/INSERT/UPDATE), so
-- a direct client-side delete would be rejected. As with soft_delete_deck,
-- we bypass RLS via SECURITY DEFINER with an explicit ownership check.
CREATE OR REPLACE FUNCTION delete_language_pair(p_source text, p_target text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM cards
  WHERE owner_id = auth.uid()
    AND source_language = p_source
    AND target_language = p_target;

  UPDATE decks
  SET deleted_at = now()
  WHERE owner_id = auth.uid()
    AND source_language = p_source
    AND target_language = p_target
    AND deleted_at IS NULL;

  DELETE FROM language_pairs
  WHERE owner_id = auth.uid()
    AND source_language = p_source
    AND target_language = p_target;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_language_pair(text, text) TO authenticated;
