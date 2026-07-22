-- Learning Pathways (Phase 1). A per-pair choice between the linear ladder and a branched pathway,
-- plus a table holding the pathway graph (mirrors learning_ladders: one row per pair + a ''/'' default).

ALTER TABLE language_pairs
  ADD COLUMN IF NOT EXISTS learning_mode TEXT NOT NULL DEFAULT 'ladder';   -- 'ladder' | 'pathway'

CREATE TABLE IF NOT EXISTS learning_pathways (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language text NOT NULL DEFAULT '',   -- '' = the user's default pathway
  target_language text NOT NULL DEFAULT '',
  pathway         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- shape = domain `Pathway`
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_language, target_language)
);

ALTER TABLE learning_pathways ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own learning_pathways" ON learning_pathways;
CREATE POLICY "own learning_pathways" ON learning_pathways
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
