-- 128_media_entries.sql — the media LOG (Media Intake Stage C, 2026-11-06).
--
-- One row per logged reading session: "I read these pages of this book." Stores the EXTRACTION
-- (marked-word candidates with their sentences, the marker config used, later the unmarked
-- lemma list) — never the images, which are parsed and discarded. The entry is the audit trail
-- for everything intake does: cards created/attached, known-words added, implicit credits.
--
-- `candidates` = IntakeCandidate[] (lib/mediaIntake.ts); `unmarked_lemmas` = text[] of every
-- unmarked printed lemma (Stage D fills it; empty until then); `stats` = loose JSONB summary of
-- the actions taken ({found, created, attached, replaced, skipped, failedWindows, deckId, …} —
-- Stage E adds credit/known counts). Soft delete: the log is the learner's reading history.

CREATE TABLE IF NOT EXISTS media_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'book',          -- 'book' | later: 'youtube'
  title           text NOT NULL,                         -- the book; groups entries + recalls markers
  source_language text NOT NULL,
  target_language text NOT NULL,
  pages           integer NOT NULL DEFAULT 0,            -- photos parsed in this entry
  markers         jsonb,                                 -- MarkerConfig used for the parse
  candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,    -- IntakeCandidate[]
  unmarked_lemmas jsonb NOT NULL DEFAULT '[]'::jsonb,    -- string[] (Stage D)
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS media_entries_user_idx
  ON media_entries (user_id, deleted_at, created_at DESC);

ALTER TABLE media_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own media_entries" ON media_entries;
CREATE POLICY "own media_entries" ON media_entries
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
