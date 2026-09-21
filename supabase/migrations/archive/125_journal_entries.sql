-- Journal: free-writing practice entries (2026-09-21). v1 keeps only the data — the text, WHICH
-- language(s) it was written in (the learner picks one or more per entry), and timestamps. The
-- page lives under Study (/study/journal). Prompts and AI feedback are planned but NOT built;
-- `prompt` exists now so shipping them later needs no migration (NULL = free write).
--
-- Soft delete (deleted_at), matching cards/folders: journal text is the learner's own writing,
-- the one kind of data a mis-tap must never destroy.

CREATE TABLE IF NOT EXISTS journal_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  languages  text[] NOT NULL DEFAULT '{}',    -- language codes used in the entry, one or more
  prompt     text,                            -- reserved for the prompts feature; NULL = free write
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS journal_entries_user_idx
  ON journal_entries (user_id, deleted_at, created_at DESC);

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own journal_entries" ON journal_entries;
CREATE POLICY "own journal_entries" ON journal_entries
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
