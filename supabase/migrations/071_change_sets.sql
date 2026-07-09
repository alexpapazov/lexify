-- 071_change_sets.sql
--
-- Persisted output of an agent run (Agent Platform, Phase 2). A dry-run agent
-- proposes a set of card changes; they land here as `pending` items the user
-- reviews and approves in the UI before anything is applied via the gateway.

CREATE TABLE IF NOT EXISTS change_sets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent      text NOT NULL,
  task       text NOT NULL DEFAULT '',
  summary    text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS change_set_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_set_id uuid NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  proposal      jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE change_sets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_set_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own change_sets" ON change_sets;
CREATE POLICY "own change_sets" ON change_sets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Items are reachable only through a change_set the user owns.
DROP POLICY IF EXISTS "own change_set_items" ON change_set_items;
CREATE POLICY "own change_set_items" ON change_set_items
  FOR ALL USING (
    EXISTS (SELECT 1 FROM change_sets cs WHERE cs.id = change_set_id AND cs.user_id = auth.uid())
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM change_sets cs WHERE cs.id = change_set_id AND cs.user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS change_sets_user_created_idx ON change_sets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS change_set_items_set_idx     ON change_set_items (change_set_id);
