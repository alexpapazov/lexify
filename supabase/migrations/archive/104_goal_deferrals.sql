-- Per-day, per-language goal deferrals ("move today's load to tomorrow").
-- A list of `${source}|${target}|${YYYY-MM-DD}` strings. A deferred day's goal is not owed that day and
-- is added to the next day's goal instead. Stored per-day (not a boolean) so it targets one specific
-- study day and composes with the carryover system (the deferred amount shifts within the running total,
-- never lost). Offered on the dashboard only when a language's remaining goal for the day is small (<5).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS goal_deferrals JSONB NOT NULL DEFAULT '[]'::jsonb;
