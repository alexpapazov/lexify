-- 133_study_sessions.sql — the external-study session log (2026-11-15).
--
-- One row per study session that happened OUTSIDE Lexify (ChatGPT batch drills, writing
-- exercises, tutoring, …): "on this day I learned/reviewed these words." The learner pastes
-- the word list, each word is matched against the library, and the per-word rating either
-- updates the EXISTING card's schedule (graduate / real FSRS review / pin to a fresh window)
-- or creates a new card born graduated. `items` is the audit trail of exactly what each word
-- got; `stats` is the loose summary ({newCards, updated, skipped, deckId}).

CREATE TABLE IF NOT EXISTS study_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language text NOT NULL,
  target_language text NOT NULL,
  studied_on      date NOT NULL,                       -- the day the session happened (≤ today)
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- SessionItem[] (lib/externalSession.ts)
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS study_sessions_user_idx
  ON study_sessions (user_id, deleted_at, studied_on DESC);

ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own study_sessions" ON study_sessions;
CREATE POLICY "own study_sessions" ON study_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
