-- 070_agent_actions.sql
--
-- Audit log for the agent platform (Phase 1). Every mutation that flows through
-- lib/agents/gateway.ts writes one row here (before/after snapshot). Dry-run
-- proposals are NOT written (they never touch data); only applied changes are.

CREATE TABLE IF NOT EXISTS agent_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor      text NOT NULL,                    -- agent id, or 'user'
  operation  text NOT NULL,                    -- 'edit' | 'create' | 'delete' | 'merge' | 'sync' | 'regen'
  card_id    uuid,
  deck_id    uuid,
  before     jsonb,
  after      jsonb,
  dry_run    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own agent_actions" ON agent_actions;
CREATE POLICY "own agent_actions" ON agent_actions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS agent_actions_user_created_idx
  ON agent_actions (user_id, created_at DESC);
