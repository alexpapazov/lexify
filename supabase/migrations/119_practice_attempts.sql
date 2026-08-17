-- 119_practice_attempts.sql — the practice attempt log.
--
-- Every practice answer is recorded: right or wrong, and — the useful half — what the learner
-- answered WITH when wrong (the typed cloze text, or the card they wrongly paired in matching).
-- Observational only: nothing reads it yet, and it never touches scheduling. It exists so a future
-- feature (confusion mining, weak-word surfacing, adaptive practice) starts with history instead
-- of a cold start.

CREATE TABLE IF NOT EXISTS practice_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exercise         TEXT NOT NULL,            -- 'cloze' | 'matching'
  card_id          UUID,                     -- the drilled card (nullable: a cloze target may be unresolvable)
  source_language  TEXT NOT NULL,
  target_language  TEXT NOT NULL,
  prompt           TEXT,                     -- cloze: the sentence; matching: the target word shown
  expected         TEXT NOT NULL,            -- the correct answer
  response         TEXT,                     -- what the learner gave (null when they gave up / revealed)
  correct          BOOLEAN NOT NULL,
  overridden       BOOLEAN NOT NULL DEFAULT FALSE,  -- cloze: learner overrode the grader's verdict
  confused_card_id UUID,                     -- matching: the card whose tile they wrongly paired
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE practice_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "practice_attempts_owner" ON practice_attempts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS practice_attempts_user_time_idx
  ON practice_attempts (user_id, created_at DESC);
