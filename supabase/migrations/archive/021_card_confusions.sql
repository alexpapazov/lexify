-- =============================================================================
-- 021_card_confusions.sql
--
-- Tracks "mix-ups" in multiple-choice recognition: when the learner is shown
-- the native-language meaning (back) and must pick the matching word in the
-- language being learned (front), but picks a DIFFERENT card's front-side
-- word instead, that's a sign the two words are easily confused (often
-- because they look/sound similar). We record these so a future "review
-- confusions" feature can surface and help disambiguate similar-looking
-- vocabulary.
--
-- One row per (user, card, confused_text) combination; `count` increments
-- each time the same mix-up happens again. `confused_with_card_id` is set
-- when the wrongly-picked text matches another card the user owns (so we can
-- link directly to it); it's left null for AI-generated distractor text that
-- doesn't correspond to a real card.
-- =============================================================================

CREATE TABLE IF NOT EXISTS card_confusions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The card that was actually shown (the correct answer the learner missed).
  card_id               UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  -- The other card whose front-side text the learner picked instead, if it
  -- corresponds to a real card the user owns.
  confused_with_card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
  -- The actual text the learner selected (always populated, even if it
  -- doesn't match a real card — e.g. an AI-generated distractor).
  confused_text         TEXT NOT NULL,
  count                 INTEGER NOT NULL DEFAULT 1,
  last_confused_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, card_id, confused_text)
);

CREATE INDEX IF NOT EXISTS card_confusions_user_card_idx ON card_confusions(user_id, card_id);

ALTER TABLE card_confusions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "card_confusions: owner only"
  ON card_confusions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Upsert-and-increment via SECURITY DEFINER function, since a plain
-- `.upsert()` from the client can't express "count = count + 1" on conflict.
CREATE OR REPLACE FUNCTION record_card_confusion(
  p_card_id   uuid,
  p_confused_text text,
  p_confused_with_card_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO card_confusions (user_id, card_id, confused_with_card_id, confused_text, count, last_confused_at)
  VALUES (auth.uid(), p_card_id, p_confused_with_card_id, p_confused_text, 1, now())
  ON CONFLICT (user_id, card_id, confused_text)
  DO UPDATE SET
    count                  = card_confusions.count + 1,
    confused_with_card_id  = COALESCE(EXCLUDED.confused_with_card_id, card_confusions.confused_with_card_id),
    last_confused_at       = now();
END;
$$;

GRANT EXECUTE ON FUNCTION record_card_confusion(uuid, text, uuid) TO authenticated;
