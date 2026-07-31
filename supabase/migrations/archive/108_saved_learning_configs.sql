-- Named, reusable ladders and pathways.
--
-- `learning_ladders` / `learning_pathways` hold the ONE config each language pair is currently using
-- (plus a ''/'' default). There was no way to keep a shape you liked, try another, and come back —
-- editing a pair's ladder overwrote it. This table is the library you save into and load from; it is
-- deliberately separate, so saving a config never disturbs what a pair is actively studying.
--
-- `config` is the opaque `Ladder` or `Pathway` JSON from domain/index.ts, exactly as those tables
-- store it — so adding fields to either shape still needs no migration.

CREATE TABLE IF NOT EXISTS saved_learning_configs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind       text NOT NULL,                       -- 'ladder' | 'pathway'
  name       text NOT NULL,
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_learning_configs_kind_check CHECK (kind IN ('ladder', 'pathway')),
  -- One name per kind per user: saving over an existing name updates it rather than quietly
  -- creating a second entry you can't tell apart in the picker.
  CONSTRAINT saved_learning_configs_unique_name UNIQUE (user_id, kind, name)
);

CREATE INDEX IF NOT EXISTS saved_learning_configs_user_kind_idx
  ON saved_learning_configs (user_id, kind, updated_at DESC);

ALTER TABLE saved_learning_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own saved_learning_configs" ON saved_learning_configs;
CREATE POLICY "own saved_learning_configs" ON saved_learning_configs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
