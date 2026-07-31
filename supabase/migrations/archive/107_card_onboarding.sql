-- Vocabulary onboarding: self-rated bulk intake of a word list.
--
-- The learner pastes a list (e.g. the 1000 most common Spanish words), the AI flags likely
-- mistranslations, anything already in the pair's library is dropped, and then each remaining card is
-- rated by confidence: 1 = don't know (learn it normally), 2/3/4 = already known, scheduled ~1 week /
-- ~1 month / ~180 days out.
--
-- Why a table at all: a band-1 card is deliberately left with NO card_states row — which is exactly
-- what an un-rated card looks like too. Without a marker there is no way to tell "rated, don't know"
-- from "never got to it", so a half-finished session could never be resumed. `band IS NULL` means
-- still to rate; the deck page offers "Finish onboarding" while any remain.

CREATE TABLE IF NOT EXISTS card_onboarding (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  deck_id    uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  -- NULL = queued, not yet rated. 1 = don't know, 2 = recognize, 3 = know it, 4 = know it cold.
  band       smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  rated_at   timestamptz,
  PRIMARY KEY (user_id, card_id),
  CONSTRAINT card_onboarding_band_range CHECK (band IS NULL OR band BETWEEN 1 AND 4)
);

-- The hot query is "how many are still queued for this deck" (deck page badge) and "give me the
-- queue" (rating screen). Partial index keeps it small — finished rows are the vast majority.
CREATE INDEX IF NOT EXISTS card_onboarding_pending_idx
  ON card_onboarding (user_id, deck_id) WHERE band IS NULL;

ALTER TABLE card_onboarding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own card_onboarding" ON card_onboarding;
CREATE POLICY "own card_onboarding" ON card_onboarding
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
