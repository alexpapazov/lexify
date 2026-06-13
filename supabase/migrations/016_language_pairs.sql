-- =============================================================================
-- 016_language_pairs.sql
--
-- "Language pairing" groupings for the Library — each pairing is a
-- (source_language, target_language) direction, matching the same
-- convention used by decks/cards:
--   source_language = the language being learned ("Target" in the UI)
--   target_language = the learner's native/basis language ("Basis" in the UI)
--
-- The Library's root view groups folders/decks into per-pairing "boxes".
-- "+ New language" creates a row here even before any deck exists for that
-- pairing, so the (empty) box appears immediately. Pairings that already
-- have decks/cards are backfilled below so existing libraries aren't empty.
-- =============================================================================

CREATE TABLE IF NOT EXISTS language_pairs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, source_language, target_language)
);

CREATE INDEX IF NOT EXISTS language_pairs_owner_idx ON language_pairs(owner_id, position);

ALTER TABLE language_pairs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "language_pairs: owner only"
  ON language_pairs FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- Backfill from existing decks and cards so current libraries already show
-- a box for every pairing the user has content in.
INSERT INTO language_pairs (owner_id, source_language, target_language)
SELECT DISTINCT owner_id, source_language, target_language
FROM decks
WHERE deleted_at IS NULL
ON CONFLICT (owner_id, source_language, target_language) DO NOTHING;

INSERT INTO language_pairs (owner_id, source_language, target_language)
SELECT DISTINCT owner_id, source_language, target_language
FROM cards
WHERE deleted_at IS NULL
ON CONFLICT (owner_id, source_language, target_language) DO NOTHING;
