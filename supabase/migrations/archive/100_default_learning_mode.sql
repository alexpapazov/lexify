-- A per-user default learning mode (ladder vs pathway) that newly added languages inherit — the mode
-- analogue of the default ladder. Per-pair `language_pairs.learning_mode` still overrides it.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS default_learning_mode TEXT NOT NULL DEFAULT 'ladder';   -- 'ladder' | 'pathway'
