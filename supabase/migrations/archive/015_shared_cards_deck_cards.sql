-- =============================================================================
-- 015_shared_cards_deck_cards.sql
--
-- Milestone 1 foundation: cards become user-owned (within a target/native
-- language direction) instead of deck-owned, so the same card can be shared
-- across multiple decks. A new deck_cards join table represents deck
-- membership. card_states/review_events already key off card_id and need no
-- changes — progress is now naturally shared across every deck containing a
-- card.
--
-- Also adds dismissed_duplicate_pairs, the Tier-2 "keep both" memory table
-- from the new card-intake pipeline's duplicate detection.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. New columns on cards: owner_id + language direction
-- ---------------------------------------------------------------------------
ALTER TABLE cards ADD COLUMN IF NOT EXISTS owner_id        UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS source_language TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS target_language TEXT;

-- Backfill from the deck each card currently belongs to.
UPDATE cards c
SET owner_id        = d.owner_id,
    source_language = d.source_language,
    target_language = d.target_language
FROM decks d
WHERE d.id = c.deck_id AND c.owner_id IS NULL;

ALTER TABLE cards ALTER COLUMN owner_id        SET NOT NULL;
ALTER TABLE cards ALTER COLUMN source_language SET NOT NULL;
ALTER TABLE cards ALTER COLUMN target_language SET NOT NULL;

CREATE INDEX IF NOT EXISTS cards_owner_lang_idx
  ON cards(owner_id, source_language, target_language)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. deck_cards join table — deck membership (many-to-many)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deck_cards (
  deck_id    UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  card_id    UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deck_id, card_id)
);
CREATE INDEX IF NOT EXISTS deck_cards_deck_idx ON deck_cards(deck_id, position);
CREATE INDEX IF NOT EXISTS deck_cards_card_idx ON deck_cards(card_id);

-- Backfill deck_cards from the existing deck_id/position on cards.
INSERT INTO deck_cards (deck_id, card_id, position)
SELECT deck_id, id, position FROM cards
ON CONFLICT (deck_id, card_id) DO NOTHING;

ALTER TABLE deck_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deck_cards: deck owner or public select" ON deck_cards FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM decks d WHERE d.id = deck_id
    AND (d.owner_id = auth.uid() OR d.is_public = TRUE)
    AND d.deleted_at IS NULL
  ));
CREATE POLICY "deck_cards: deck owner insert" ON deck_cards FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.owner_id = auth.uid()));
CREATE POLICY "deck_cards: deck owner update" ON deck_cards FOR UPDATE
  USING (EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.owner_id = auth.uid()));
CREATE POLICY "deck_cards: deck owner delete" ON deck_cards FOR DELETE
  USING (EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. cards: drop deck_id, rewrite RLS to be owner-based
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "cards: deck owner or public" ON cards;
DROP POLICY IF EXISTS "cards: deck owner insert"    ON cards;
DROP POLICY IF EXISTS "cards: deck owner update"    ON cards;
DROP INDEX IF EXISTS cards_deck_id_idx;
ALTER TABLE cards DROP COLUMN IF EXISTS deck_id;

CREATE POLICY "cards: owner select" ON cards FOR SELECT
  USING (deleted_at IS NULL AND (
    owner_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
      WHERE dc.card_id = cards.id AND d.is_public = TRUE AND d.deleted_at IS NULL
    )
  ));
CREATE POLICY "cards: owner insert" ON cards FOR INSERT WITH CHECK (owner_id = auth.uid());
CREATE POLICY "cards: owner update" ON cards FOR UPDATE USING (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. dismissed_duplicate_pairs — Tier-2 "keep both" memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dismissed_duplicate_pairs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_a_id  UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  card_b_id  UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (card_a_id <> card_b_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dismissed_pairs_unique_idx
  ON dismissed_duplicate_pairs (user_id, LEAST(card_a_id, card_b_id), GREATEST(card_a_id, card_b_id));

ALTER TABLE dismissed_duplicate_pairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dismissed_pairs: owner all" ON dismissed_duplicate_pairs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 5. reset_deck_progress: cards.deck_id no longer exists — go through deck_cards.
--    Cards may now be shared across decks, so this only clears progress/choices
--    for cards linked to THIS deck (a card shared with another deck still has
--    its choices cleared too, since the cached pool depends on the card's own
--    front/back, not which deck it's viewed from).
-- ---------------------------------------------------------------------------
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
    AND card_id IN (SELECT card_id FROM deck_cards WHERE deck_id = p_deck_id);

  UPDATE cards
  SET choices = NULL
  WHERE id IN (SELECT card_id FROM deck_cards WHERE deck_id = p_deck_id)
    AND choices IS NOT NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION reset_deck_progress(uuid) TO authenticated;
