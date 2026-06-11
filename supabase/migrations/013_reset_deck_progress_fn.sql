-- Migration 013: reset all study progress for a deck.
--
-- "Reset deck" (from the deck editor) wipes the current user's
-- spaced-repetition progress for every card in the deck — pipeline step,
-- graduation, due dates, ease/interval/reps/lapses, introduced_date — back
-- to "never studied", and clears each card's cached AI multiple-choice
-- distractor pool (`cards.choices`) so it regenerates fresh.
--
-- The deck's cards, name, languages, and settings are untouched. Review
-- history (review_events) is left alone — it's an immutable log.
--
-- Implemented as SECURITY DEFINER (like soft_delete_deck in 011) so it can
-- delete card_states rows and update cards.choices in one atomic statement,
-- with an explicit ownership check, regardless of the per-table RLS quirks
-- we've hit elsewhere.
CREATE OR REPLACE FUNCTION reset_deck_progress(p_deck_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM decks WHERE id = p_deck_id AND owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Deck not found or not owned by current user';
  END IF;

  DELETE FROM card_states
  WHERE user_id = auth.uid()
    AND card_id IN (SELECT id FROM cards WHERE deck_id = p_deck_id);

  UPDATE cards
  SET choices = NULL
  WHERE deck_id = p_deck_id AND choices IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION reset_deck_progress(uuid) TO authenticated;
