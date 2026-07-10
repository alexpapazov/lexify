-- 073_ladder_climb.sql
--
-- Per-card progress up a configurable learning ladder (Stage 3). One row per
-- (user, card); the climb state (rung index, counters, window start, computed
-- intervals) is stored as JSON matching the engine's ClimbState. Kept separate
-- from card_states so the new "practice ladder" mode doesn't disturb the existing
-- study/scheduling flow (the cutover is Stage 4).

CREATE TABLE IF NOT EXISTS ladder_climb (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id    uuid NOT NULL,
  deck_id    uuid,
  state      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id)
);

ALTER TABLE ladder_climb ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own ladder_climb" ON ladder_climb;
CREATE POLICY "own ladder_climb" ON ladder_climb
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
