-- Weekly goals per language pair (keys "0"–"6" = JS day-of-week, null = no goal that day)
ALTER TABLE language_pairs ADD COLUMN IF NOT EXISTS goals JSONB;

-- Whether fast-tracked (import_known) cards count toward the daily goal
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS goals_count_accelerated BOOLEAN NOT NULL DEFAULT false;
