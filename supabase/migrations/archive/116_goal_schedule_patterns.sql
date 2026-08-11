-- Schedules without a finish line, and a ceiling across ALL languages.
--
-- 1. PATTERN SCHEDULES. A schedule used to require "N words by date D". But "8 a day, none on
--    Sundays" is a perfectly good schedule — it just has no total to reach. Making target_count and
--    deadline nullable lets that be expressed, so the weekday numbers alone are a valid schedule and
--    still get days off, per-date caps, and a place on the combined calendar. A pattern schedule has
--    nothing to be ahead or behind of, so pace/feasibility/re-spreading simply don't apply to it.
--
--    Both nullable, but a target without a deadline is meaningless (nothing to spread across), so
--    the check enforces "deadline present whenever target is".
--
-- 2. profiles.daily_word_ceiling — the most new words the learner will do in a day across EVERY
--    language combined. Per-schedule ceilings can't express this: three languages each capped at 10
--    still add up to 30. NULL = no limit.

ALTER TABLE goal_schedules ALTER COLUMN target_count DROP NOT NULL;
ALTER TABLE goal_schedules ALTER COLUMN deadline     DROP NOT NULL;

ALTER TABLE goal_schedules DROP CONSTRAINT IF EXISTS goal_schedules_target_check;
ALTER TABLE goal_schedules ADD  CONSTRAINT goal_schedules_target_check
  CHECK (target_count IS NULL OR target_count > 0);

ALTER TABLE goal_schedules DROP CONSTRAINT IF EXISTS goal_schedules_dates_check;
ALTER TABLE goal_schedules ADD  CONSTRAINT goal_schedules_dates_check
  CHECK (deadline IS NULL OR deadline >= start_date);

-- A target with no deadline has nothing to spread across.
ALTER TABLE goal_schedules DROP CONSTRAINT IF EXISTS goal_schedules_target_needs_deadline;
ALTER TABLE goal_schedules ADD  CONSTRAINT goal_schedules_target_needs_deadline
  CHECK (target_count IS NULL OR deadline IS NOT NULL);

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS daily_word_ceiling integer;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_daily_word_ceiling_check;
ALTER TABLE profiles ADD  CONSTRAINT profiles_daily_word_ceiling_check
  CHECK (daily_word_ceiling IS NULL OR daily_word_ceiling > 0);
