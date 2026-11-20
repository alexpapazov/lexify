-- 134_review_programs.sql — the program builder's per-day state (Due Now Redesign Part 2).
--
-- One row per (pair, direction, local day): the stage chain chosen for that batch and each
-- word's progress through it. Progress persists so a half-done program resumes later the same
-- day; at day turnover the row is FINALIZED (lazily, on the next app open): every progressed,
-- un-credited, un-locked word gets its highest cleared stage's grow-only interval boost.
-- `day` is the turnover-aware local date string the client computed, not a server date.

CREATE TABLE IF NOT EXISTS review_programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language text NOT NULL,
  target_language text NOT NULL,
  direction       text NOT NULL DEFAULT 'production',    -- 'production' | 'recognition'
  day             date NOT NULL,
  stages          jsonb NOT NULL DEFAULT '[]'::jsonb,    -- StageKind[] (engine/program.ts)
  progress        jsonb NOT NULL DEFAULT '{}'::jsonb,    -- cardId -> WordProgress
  finalized_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_language, target_language, direction, day)
);

CREATE INDEX IF NOT EXISTS review_programs_open_idx
  ON review_programs (user_id, finalized_at, day);

ALTER TABLE review_programs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own review_programs" ON review_programs;
CREATE POLICY "own review_programs" ON review_programs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
