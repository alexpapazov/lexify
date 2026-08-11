-- How the learner sets goals, for ALL languages at once.
--
-- Was a per-language choice on the goals page; it is now one toggle at the top, because "am I working
-- to a repeating number or to a deadline" is a decision about how you study, not about Spanish
-- specifically. Stored on the profile rather than in localStorage so it follows the user between
-- desktop and the phone.
--
-- 'daily' / 'weekday' both read language_pairs.goals (the difference is only whether the seven
-- numbers are edited together); 'schedule' hands every language to its goal_schedules row.
--
-- NOTE: this column is a UI mode. What actually drives the goal surfaces is still "does this pair
-- have a non-archived goal_schedules row" — see features/Goal Scheduler.md §2. Switching away from
-- 'schedule' therefore offers to retire the live schedules rather than leaving them silently
-- driving goals behind a UI that shows weekday boxes.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS goal_mode text NOT NULL DEFAULT 'daily';

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_goal_mode_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_goal_mode_check CHECK (goal_mode IN ('daily', 'weekday', 'schedule'));
