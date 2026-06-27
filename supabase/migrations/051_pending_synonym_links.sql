-- Pending synonym links: when a user adds a synonym that doesn't exist as a card yet,
-- a row is stored here. When the card is later created, the synonym connection is
-- applied automatically (bidirectional backSynonyms).

CREATE TABLE IF NOT EXISTS pending_synonym_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_word      TEXT NOT NULL,          -- unregistered word (e.g. "querer")
  source_language  TEXT NOT NULL,          -- e.g. "es"
  target_language  TEXT NOT NULL,          -- e.g. "en"
  linked_card_id   UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_word, source_language, target_language, linked_card_id)
);

ALTER TABLE pending_synonym_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own pending synonym links"
  ON pending_synonym_links FOR ALL
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
