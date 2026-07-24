-- =============================================================================
-- 026_card_confusion_word_mixups.sql
--
-- Extends card_confusions (migration 021) with two columns so frequently-
-- confused words can be fed back into multiple-choice distractors
-- (lib/distractors.ts: promoteConfusionDistractor()):
--
--   - answer_side:  which side of `card_id` the learner was asked to
--     produce when this mix-up happened ('front' = shown back, produce
--     front; 'back' = shown front, produce back). Lets distractor-building
--     for a given side only consider confusions recorded on that same side.
--
--   - is_word_mixup: true if `confused_text` represents a genuinely
--     different word — always true for multiple-choice picks (the choice is
--     necessarily a real word/distractor), and for typed answers true only
--     when engine/grading.ts: isDifferentWordMistake() says the typed answer
--     wasn't just a close typo/spelling/accent/article slip. Only
--     word-level mix-ups are eligible for promotion to a distractor.
--
-- Existing rows (all recorded before this migration, i.e. from
-- multiple-choice recognition picks only) default to answer_side = 'front'
-- (the original card_confusions use case: shown back, picked the wrong
-- front-side word) and is_word_mixup = true (a multiple-choice pick is
-- always a real word).
-- =============================================================================

ALTER TABLE card_confusions
  ADD COLUMN IF NOT EXISTS answer_side TEXT NOT NULL DEFAULT 'front' CHECK (answer_side IN ('front', 'back')),
  ADD COLUMN IF NOT EXISTS is_word_mixup BOOLEAN NOT NULL DEFAULT true;

-- Replace record_card_confusion() to accept + persist the new columns.
DROP FUNCTION IF EXISTS record_card_confusion(uuid, text, uuid);

CREATE OR REPLACE FUNCTION record_card_confusion(
  p_card_id   uuid,
  p_confused_text text,
  p_answer_side text,
  p_is_word_mixup boolean,
  p_confused_with_card_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO card_confusions (user_id, card_id, confused_with_card_id, confused_text, answer_side, is_word_mixup, count, last_confused_at)
  VALUES (auth.uid(), p_card_id, p_confused_with_card_id, p_confused_text, p_answer_side, p_is_word_mixup, 1, now())
  ON CONFLICT (user_id, card_id, confused_text)
  DO UPDATE SET
    count                  = card_confusions.count + 1,
    confused_with_card_id  = COALESCE(EXCLUDED.confused_with_card_id, card_confusions.confused_with_card_id),
    answer_side            = EXCLUDED.answer_side,
    -- Once a mix-up is flagged as word-level, keep it that way even if a
    -- later repeat of the same text happens to be classified as a typo.
    is_word_mixup          = card_confusions.is_word_mixup OR EXCLUDED.is_word_mixup,
    last_confused_at       = now();
END;
$$;

GRANT EXECUTE ON FUNCTION record_card_confusion(uuid, text, text, boolean, uuid) TO authenticated;
