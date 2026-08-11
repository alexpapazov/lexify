-- Pattern schedules grow three things (2026-08-10):
--
-- 1. weekly_target — "42 words a WEEK", spread across the week's study days (days off excluded),
--    the same every week. NULL = the existing daily framing. Mutually exclusive with target_count:
--    a weekly number and a finish-line target are different kinds of goal.
-- 2. DEBT — opt-in carryover for daily/weekly patterns, per flag: debt_carry_missed rolls a
--    shortfall into the next day's goal, debt_carry_extra banks a surplus against it. Both derived,
--    never stored (planned-since-start minus done-since-start, same statelessness as everything
--    else); the schedule's daily_ceiling caps the debt-adjusted goal and the remainder defers on.
--    LONG-TERM goals never get debt — re-spreading already absorbs misses, so debt would
--    double-charge (the same rule that keeps profile carryover off scheduled pairs).
-- 3. debt_reset_at — "start the balance from here", set by the Reset button. A date, not a zeroed
--    counter, because the balance is derived (same trick as profiles.goal_full_debt_resets).

ALTER TABLE goal_schedules
  ADD COLUMN IF NOT EXISTS weekly_target integer,
  ADD COLUMN IF NOT EXISTS debt_carry_missed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS debt_carry_extra boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS debt_reset_at date;

ALTER TABLE goal_schedules DROP CONSTRAINT IF EXISTS goal_schedules_weekly_check;
ALTER TABLE goal_schedules ADD CONSTRAINT goal_schedules_weekly_check
  CHECK (weekly_target IS NULL OR weekly_target > 0);

ALTER TABLE goal_schedules DROP CONSTRAINT IF EXISTS goal_schedules_weekly_vs_target;
ALTER TABLE goal_schedules ADD CONSTRAINT goal_schedules_weekly_vs_target
  CHECK (weekly_target IS NULL OR target_count IS NULL);
