-- 072_learning_ladders.sql
--
-- Configurable learning ladders (Stage 1). One ladder per language pair, plus a
-- per-user DEFAULT ladder that seeds newly added languages. The default row uses
-- empty-string source/target (''/''), so a single table + primary key covers both.
-- `rungs` is the ordered rung list as JSON (shape = domain `Rung[]`).

CREATE TABLE IF NOT EXISTS learning_ladders (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language text NOT NULL DEFAULT '',   -- '' = the user's default ladder
  target_language text NOT NULL DEFAULT '',
  rungs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_language, target_language)
);

ALTER TABLE learning_ladders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own learning_ladders" ON learning_ladders;
CREATE POLICY "own learning_ladders" ON learning_ladders
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
