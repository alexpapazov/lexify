-- 066_typed_grading_categories.sql
--
-- Per-category typed-answer grading strictness + error capture.
--
-- 1. Per-pair strictness flags (canonical on the forward_typed row) — for each of
--    spelling / accents / articles, strict (penalize the slip) vs. lenient (no
--    scheduling penalty; learner still retypes). Default strict = true (matches the
--    prior behavior where these slips counted).
-- 2. Generalize review_events.near_miss (boolean) into a weighted near-miss so a
--    spelling slip (0.30) can weigh more than an accent/article slip (0.20). The old
--    boolean stays for backward-compat; near_miss_weight is the source of truth.
-- 3. typing_error_marks — records accent / article / spelling slips per card/side so
--    future "spelling practice" and "gender/article assign" modes have data to draw on.

-- 1. Strictness flags -----------------------------------------------------------
ALTER TABLE user_scheduler_params
  ADD COLUMN IF NOT EXISTS strict_spelling BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS strict_accents  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS strict_articles BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Weighted near-miss + error category ---------------------------------------
ALTER TABLE review_events
  ADD COLUMN IF NOT EXISTS near_miss_weight REAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_category   TEXT
    CHECK (error_category IN ('spelling', 'accent', 'article'));

-- Backfill weight from the existing boolean (old near-misses were worth 0.2).
UPDATE review_events SET near_miss_weight = 0.2 WHERE near_miss = TRUE AND near_miss_weight = 0;

-- 3. Error capture table --------------------------------------------------------
CREATE TABLE IF NOT EXISTS typing_error_marks (
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id       UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  answer_side   TEXT NOT NULL CHECK (answer_side IN ('front', 'back')),
  category      TEXT NOT NULL CHECK (category IN ('spelling', 'accent', 'article')),
  count         INTEGER NOT NULL DEFAULT 1,
  last_expected TEXT NOT NULL DEFAULT '',
  last_user_answer TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id, answer_side, category)
);

CREATE INDEX IF NOT EXISTS typing_error_marks_user_cat_idx
  ON typing_error_marks(user_id, category);

ALTER TABLE typing_error_marks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS typing_error_marks_owner ON typing_error_marks;
CREATE POLICY typing_error_marks_owner ON typing_error_marks
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Upsert helper: increment count + refresh last_* on repeat.
CREATE OR REPLACE FUNCTION record_typing_error_mark(
  p_card_id     UUID,
  p_answer_side TEXT,
  p_category    TEXT,
  p_expected    TEXT,
  p_user_answer TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO typing_error_marks (user_id, card_id, answer_side, category, count, last_expected, last_user_answer, updated_at)
  VALUES (auth.uid(), p_card_id, p_answer_side, p_category, 1, p_expected, p_user_answer, NOW())
  ON CONFLICT (user_id, card_id, answer_side, category) DO UPDATE SET
    count            = typing_error_marks.count + 1,
    last_expected    = EXCLUDED.last_expected,
    last_user_answer = EXCLUDED.last_user_answer,
    updated_at       = NOW();
END;
$$;
