-- Migration 018: deleting a deck should also clean up cards that become
-- orphaned as a result — i.e. cards that were only linked to this deck and
-- are not linked to any other (non-deleted) deck. Cards still shared with
-- other decks are left untouched.
--
-- This extends the existing soft_delete_deck() SECURITY DEFINER function
-- (migration 011) so the cleanup happens atomically with the deck deletion.

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

  -- Soft-delete any cards that were linked to this deck and are not linked
  -- to any other deck that isn't itself deleted.
  UPDATE cards
  SET deleted_at = now()
  WHERE deleted_at IS NULL
    AND id IN (SELECT card_id FROM deck_cards WHERE deck_id = p_deck_id)
    AND NOT EXISTS (
      SELECT 1
      FROM deck_cards dc
      JOIN decks d ON d.id = dc.deck_id
      WHERE dc.card_id = cards.id
        AND dc.deck_id <> p_deck_id
        AND d.deleted_at IS NULL
    );
END;
$$;

GRANT EXECUTE ON FUNCTION soft_delete_deck(uuid) TO authenticated;

-- One-time backfill: clean up cards left orphaned by decks that were already
-- deleted before this fix existed (e.g. cards still showing as "in your
-- library, but not currently in any deck" with no path to remove them).
UPDATE cards
SET deleted_at = now()
WHERE deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM deck_cards WHERE card_id = cards.id)
  AND NOT EXISTS (
    SELECT 1
    FROM deck_cards dc
    JOIN decks d ON d.id = dc.deck_id
    WHERE dc.card_id = cards.id
      AND d.deleted_at IS NULL
  );
