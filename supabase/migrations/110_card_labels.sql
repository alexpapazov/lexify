-- 110_card_labels.sql — part-of-speech + lemma labels on cards (practice-mode groundwork).
--
-- `pos` is one of: noun, verb, adjective, adverb, pronoun, preposition, conjunction, determiner,
-- interjection, numeral, phrase, other. 'phrase' is the catch-all for multi-word fronts that aren't
-- a single classifiable unit (whole sentences, idioms). `lemma` is the dictionary citation form of
-- card.front (leading article stripped, lowercase unless a proper noun; reflexive pronouns kept when
-- the citation form carries them, e.g. "se précipiter"). Both NULL until the labeling pass runs.
-- Enforcement of the pos value set lives in application code (app/api/cards/label), matching how
-- other enum-ish text columns are handled.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS pos   TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS lemma TEXT;

-- Bulk label writer: one RPC per batch instead of one UPDATE round-trip per card — a first backfill
-- can be thousands of cards. Runs with invoker rights; the owner_id check scopes writes to the
-- caller's own cards (belt and braces on top of RLS).
CREATE OR REPLACE FUNCTION set_card_labels(p_labels JSONB)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE cards c
  SET pos = l.pos, lemma = l.lemma, updated_at = now()
  FROM jsonb_to_recordset(p_labels) AS l(id UUID, pos TEXT, lemma TEXT)
  WHERE c.id = l.id AND c.owner_id = auth.uid();
$$;
