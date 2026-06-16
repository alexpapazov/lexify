-- Add per-user timezone preference to profiles.
-- NULL means "use UTC" (backward-compatible default).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS timezone TEXT;
