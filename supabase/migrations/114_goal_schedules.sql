-- Deadline-driven goals: "N words in this language by date D".
--
-- `language_pairs.goals` answers "how many a day do I want". This answers the opposite question and
-- derives the daily number from the deadline. While a pair has a non-archived schedule, the schedule
-- SUPERSEDES that pair's weekday goals and carryover mode — the daily number is re-derived from
-- (words left ÷ capacity left) every morning, so a missed day raises the rest of the schedule
-- slightly instead of dropping a spike on tomorrow. Nothing about that derivation is stored here;
-- see the header of lib/goalSchedule.ts for why that statelessness is load-bearing.
--
-- `baseline_count` is the ONE exception, and it is a snapshot rather than a running total: the value
-- the measure had the day the schedule was created (0 for 'new_words', the pair's graduated count for
-- 'total_words'), so progress has a floor to measure from.

CREATE TABLE IF NOT EXISTS goal_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language text NOT NULL,
  target_language text NOT NULL,
  name            text,
  target_kind     text NOT NULL DEFAULT 'new_words',
  target_count    integer NOT NULL,
  start_date      date NOT NULL,
  deadline        date NOT NULL,
  baseline_count  integer NOT NULL DEFAULT 0,
  daily_ceiling   integer,                          -- NULL = uncapped
  weekday_limits  jsonb,                            -- {"0": 0, "6": 0} → weekends off
  date_exceptions jsonb,                            -- {"2026-08-12": 0} → away that day
  checkpoints     jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{date, count}], count CUMULATIVE
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_schedules_kind_check   CHECK (target_kind IN ('new_words', 'total_words')),
  CONSTRAINT goal_schedules_target_check CHECK (target_count > 0),
  CONSTRAINT goal_schedules_dates_check  CHECK (deadline >= start_date),
  CONSTRAINT goal_schedules_ceiling_check CHECK (daily_ceiling IS NULL OR daily_ceiling > 0)
);

-- One ACTIVE schedule per pair. Two live schedules would each derive a daily number from their own
-- deadline and the goal surfaces would have to pick one arbitrarily; archived rows stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS goal_schedules_one_active_per_pair
  ON goal_schedules (user_id, source_language, target_language)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS goal_schedules_user_idx
  ON goal_schedules (user_id, archived_at, deadline);

ALTER TABLE goal_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own goal_schedules" ON goal_schedules;
CREATE POLICY "own goal_schedules" ON goal_schedules
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
