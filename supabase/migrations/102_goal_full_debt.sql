-- Full-debt goal carryover (unbounded, cumulative).
-- When on, a language's shortfall/surplus accumulates across ALL days since it was enabled (not just
-- yesterday): incomplete cards always roll onto the next day, and extra study rolls credit forward
-- multiple days. Stateless model — just the toggle + the day it was enabled; today's goal is computed
-- as base - (graduations since enable - planned goals since enable).

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS goal_full_debt       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS goal_full_debt_since DATE;
