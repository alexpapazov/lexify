-- 004_learning_languages.sql
-- Stores the user's selected learning languages as a JSON array on their profile.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS learning_languages JSONB NOT NULL DEFAULT '[]';
