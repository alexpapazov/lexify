-- 120_sequential_goal_schedules.sql — sequential goals.
--
-- A pair may now hold SEVERAL live schedules — a queue: finish this one, the next takes over.
-- The one-live-schedule-per-pair unique index enforced the old single-goal world, so it goes;
-- which schedule is ACTIVE is decided in code by date (`pickCurrentSchedule`): the earliest-starting
-- live schedule whose deadline hasn't passed. Nothing is stored about activation — like every other
-- goal mechanism, it's derived, so it can't drift.

DROP INDEX IF EXISTS goal_schedules_one_active_per_pair;

CREATE INDEX IF NOT EXISTS goal_schedules_live_pair_idx
  ON goal_schedules (user_id, source_language, target_language)
  WHERE archived_at IS NULL;
