-- 113_practice_sentences.sql — the practice sentence bank.
--
-- Generated cloze sentences are cached per (user, language pair, target lemma) so a second session
-- over the same words costs no API calls. This matters more since practice can be pointed at a
-- whole deck or "everything due this week" — a 30-word session is otherwise 30 sentences to write.
--
-- `exercise` stores the WHOLE annotated exercise (sentence, answer, translation, per-word lemma +
-- part of speech + gloss), because the annotations are what let a stored sentence be re-judged
-- later. It is deliberately keyed by LEMMA rather than card_id: the lemma is what the sentence
-- actually drills, and it survives the card being deleted and re-added by a different import.
--
-- ⚠️ We never store whether a sentence PASSED. Whether it's usable depends on the learner's library
-- (which grows) and on the "% graduated" slider (which they can change), so it is re-scored against
-- the current library every time it's read — see engine/practiceBank.ts.

CREATE TABLE IF NOT EXISTS practice_sentences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language text NOT NULL,
  target_language text NOT NULL,
  -- Citation form of the word this sentence drills (cards.lemma).
  target_lemma    text NOT NULL,
  exercise        jsonb NOT NULL,
  -- Drives variety: the bank hands out least-used sentences first.
  use_count       integer NOT NULL DEFAULT 0,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The only read: "sentences for these lemmas, in this pair, least-used first".
CREATE INDEX IF NOT EXISTS practice_sentences_lookup_idx
  ON practice_sentences (user_id, source_language, target_language, target_lemma, use_count);

ALTER TABLE practice_sentences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own practice_sentences" ON practice_sentences;
CREATE POLICY "own practice_sentences" ON practice_sentences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
