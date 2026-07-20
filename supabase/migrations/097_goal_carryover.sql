-- Goal carryover: let yesterday's shortfall or surplus adjust today's per-language goal.
-- Both default FALSE so existing users see no change until they opt in.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS goal_carry_shortfall BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS goal_carry_surplus   BOOLEAN NOT NULL DEFAULT FALSE;
