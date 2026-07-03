-- Track whether (and how much of) a "Hint" was used on a Due Now review.
-- 0 = no hint, 1 = first letter / syllable core, 2 = two letters / full first syllable.
ALTER TABLE review_events
  ADD COLUMN IF NOT EXISTS hint_level INTEGER NOT NULL DEFAULT 0;
