-- Hour of day (0-23) at which a new study day begins in the user's timezone.
-- Default 0 = midnight. E.g. 4 means studying at 3 AM counts as the previous day.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS day_turnover_hour INTEGER NOT NULL DEFAULT 0;
