-- Bidirectional confusion links between two cards.
-- A link means the user has identified (or the system auto-detected) that
-- these two cards are easily confused with each other.
-- card_a_id is always the lexicographically smaller UUID so that the pair
-- (a, b) and (b, a) map to the same row.

CREATE TABLE IF NOT EXISTS card_confusion_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_a_id  UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  card_b_id  UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT card_confusion_links_ordered CHECK (card_a_id < card_b_id),
  UNIQUE (user_id, card_a_id, card_b_id)
);

CREATE INDEX IF NOT EXISTS card_confusion_links_a_idx ON card_confusion_links(user_id, card_a_id);
CREATE INDEX IF NOT EXISTS card_confusion_links_b_idx ON card_confusion_links(user_id, card_b_id);

ALTER TABLE card_confusion_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own confusion links"
  ON card_confusion_links FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
