-- Per-day exemptions from full-debt carryover.
-- "Do not carry over today's incomplete cards" / "…today's surplus" — each waives ONE day's deficit or
-- credit. Stored as a LIST of study-day dates rather than a boolean so that (a) the checkbox auto-
-- unchecks once day turnover passes (checked == the list contains today), with no cron, and (b) a day
-- you forgave STAYS forgiven in the cumulative total — a boolean that flipped off tomorrow would let
-- the waived debt silently come back.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS full_debt_skip_shortfall_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS full_debt_skip_surplus_days   JSONB NOT NULL DEFAULT '[]'::jsonb;
