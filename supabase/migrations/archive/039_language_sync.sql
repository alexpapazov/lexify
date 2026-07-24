-- Migration 039: language syncing infrastructure
-- Three tables:
--   language_sync_rules   — one rule per (user, source_pair, dest_pair)
--   synced_card_links     — tracks each generated card + review status
--   language_sync_state   — stable folder/deck infra per sync direction

-- ── language_sync_rules ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS language_sync_rules (
  id                                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                             UUID        NOT NULL REFERENCES auth.users(id),
  source_pair_id                      UUID        NOT NULL REFERENCES language_pairs(id),
  destination_pair_id                 UUID        NOT NULL REFERENCES language_pairs(id),
  enabled                             BOOLEAN     NOT NULL DEFAULT true,
  mode                                TEXT        NOT NULL DEFAULT 'review_first'
    CHECK (mode IN ('review_first', 'auto')),
  trigger                             TEXT        NOT NULL DEFAULT 'manual_only'
    CHECK (trigger IN ('on_card_created', 'on_card_graduated', 'manual_only')),
  allow_synced_cards_to_trigger_sync  BOOLEAN     NOT NULL DEFAULT false,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, source_pair_id, destination_pair_id)
);

ALTER TABLE language_sync_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_language_sync_rules"
ON language_sync_rules
USING     (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ── synced_card_links ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS synced_card_links (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id),
  source_card_id        UUID        NOT NULL REFERENCES cards(id),
  synced_card_id        UUID        REFERENCES cards(id),  -- NULL = dismissed
  source_pair_id        UUID        NOT NULL REFERENCES language_pairs(id),
  destination_pair_id   UUID        NOT NULL REFERENCES language_pairs(id),
  sync_rule_id          UUID        NOT NULL REFERENCES language_sync_rules(id),
  source_front_at_sync  TEXT        NOT NULL,
  source_back_at_sync   TEXT        NOT NULL,
  generated_front       TEXT        NOT NULL,
  generated_back        TEXT        NOT NULL,
  confidence            FLOAT,
  warning               TEXT,
  status                TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'dismissed', 'manually_edited')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_card_id, destination_pair_id)
);

ALTER TABLE synced_card_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_synced_card_links"
ON synced_card_links
USING     (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ── language_sync_state ───────────────────────────────────────────────────────
-- Stores stable folder/deck IDs so the same infrastructure is reused across
-- multiple syncs for the same direction, preventing duplicate folder creation.

CREATE TABLE IF NOT EXISTS language_sync_state (
  user_id               UUID        NOT NULL REFERENCES auth.users(id),
  source_pair_id        UUID        NOT NULL REFERENCES language_pairs(id),
  destination_pair_id   UUID        NOT NULL REFERENCES language_pairs(id),
  root_folder_id        UUID        NOT NULL REFERENCES folders(id),
  sub_folder_id         UUID        NOT NULL REFERENCES folders(id),
  deck_id               UUID        NOT NULL REFERENCES decks(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source_pair_id, destination_pair_id)
);

ALTER TABLE language_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_language_sync_state"
ON language_sync_state
USING     (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ── updated_at triggers ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_language_sync_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS language_sync_rules_updated_at ON language_sync_rules;
CREATE TRIGGER language_sync_rules_updated_at
  BEFORE UPDATE ON language_sync_rules
  FOR EACH ROW EXECUTE FUNCTION update_language_sync_updated_at();

DROP TRIGGER IF EXISTS synced_card_links_updated_at ON synced_card_links;
CREATE TRIGGER synced_card_links_updated_at
  BEFORE UPDATE ON synced_card_links
  FOR EACH ROW EXECUTE FUNCTION update_language_sync_updated_at();

DROP TRIGGER IF EXISTS language_sync_state_updated_at ON language_sync_state;
CREATE TRIGGER language_sync_state_updated_at
  BEFORE UPDATE ON language_sync_state
  FOR EACH ROW EXECUTE FUNCTION update_language_sync_updated_at();
