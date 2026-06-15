-- =============================================================================
-- 025_typed_answer_overrides.sql
--
-- Persists per-card, per-direction "this typed answer counts as correct"
-- overrides, set via TypingMode's "Override as correct" / "Override as
-- incorrect" controls.
--
-- One row per (user, card, answer_side, answer_text) means: when the
-- learner is asked to produce `answer_side` for `card_id` and types
-- `answer_text` (normalized per the deck's grading settings), it should be
-- accepted as correct even if gradeTyping() alone would mark it wrong.
--
-- Row lifecycle:
--   - "Override as correct" on a naturally-wrong answer  -> insert a row.
--   - "Override as incorrect" on an answer that was only correct *because*
--     of a previously-persisted override -> delete that row.
--   - "Undo override" reverses whichever of the above just happened.
-- Naturally-correct answers marked "Override as incorrect" are NOT persisted
-- here — that override remains session-local, as before.
-- =============================================================================

CREATE TABLE IF NOT EXISTS typed_answer_overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id     UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  answer_side TEXT NOT NULL CHECK (answer_side IN ('front', 'back')),
  -- Stored normalized (per the deck's grading settings at write time) — this
  -- is exactly the `normalizedUser` string gradeTyping() would compare.
  answer_text TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, card_id, answer_side, answer_text)
);

CREATE INDEX IF NOT EXISTS typed_answer_overrides_user_card_idx
  ON typed_answer_overrides(user_id, card_id, answer_side);

ALTER TABLE typed_answer_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "typed_answer_overrides: owner only"
  ON typed_answer_overrides FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
