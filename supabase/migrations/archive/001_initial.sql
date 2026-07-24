-- =============================================================================
-- 001_initial.sql
-- Full schema: UUID PKs, updated_at trigger, soft deletes, RLS on every table.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles: owner select" ON profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "profiles: owner update" ON profiles FOR UPDATE USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- pipelines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipelines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE TRIGGER pipelines_updated_at BEFORE UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pipelines: read system or own" ON pipelines FOR SELECT USING (owner_id IS NULL OR auth.uid() = owner_id);
CREATE POLICY "pipelines: owner insert"       ON pipelines FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "pipelines: owner update"       ON pipelines FOR UPDATE USING (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- pipeline_steps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id      UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  step_order       INTEGER NOT NULL,
  step_type        TEXT NOT NULL CHECK (step_type IN ('recognition','typing')),
  prompt_side      TEXT NOT NULL CHECK (prompt_side IN ('front','back')),
  answer_side      TEXT NOT NULL CHECK (answer_side IN ('front','back')),
  required_correct INTEGER NOT NULL CHECK (required_correct >= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pipeline_id, step_order)
);
CREATE TRIGGER pipeline_steps_updated_at BEFORE UPDATE ON pipeline_steps FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE pipeline_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pipeline_steps: read if pipeline visible" ON pipeline_steps FOR SELECT
  USING (EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_id AND (p.owner_id IS NULL OR p.owner_id = auth.uid())));

-- ---------------------------------------------------------------------------
-- decks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  source_language  TEXT NOT NULL DEFAULT 'en',
  target_language  TEXT NOT NULL DEFAULT 'es',
  pipeline_id      UUID NOT NULL REFERENCES pipelines(id),
  grading_settings JSONB NOT NULL DEFAULT '{"accentInsensitive":true,"articleOptional":false,"caseInsensitive":true,"allowOneTypo":false,"acceptSlashAlternatives":true,"ignoreParentheticals":true}',
  is_public        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);
CREATE TRIGGER decks_updated_at BEFORE UPDATE ON decks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "decks: owner select"  ON decks FOR SELECT USING (auth.uid() = owner_id AND deleted_at IS NULL);
CREATE POLICY "decks: public select" ON decks FOR SELECT USING (is_public = TRUE AND deleted_at IS NULL);
CREATE POLICY "decks: owner insert"  ON decks FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "decks: owner update"  ON decks FOR UPDATE USING (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cards (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id    UUID NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front      TEXT NOT NULL,
  back       TEXT NOT NULL,
  hints      JSONB NOT NULL DEFAULT '[]',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX cards_deck_id_idx ON cards(deck_id);
CREATE TRIGGER cards_updated_at BEFORE UPDATE ON cards FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cards: deck owner or public" ON cards FOR SELECT
  USING (deleted_at IS NULL AND (
    EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.owner_id = auth.uid()) OR
    EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.is_public = TRUE)
  ));
CREATE POLICY "cards: deck owner insert" ON cards FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.owner_id = auth.uid()));
CREATE POLICY "cards: deck owner update" ON cards FOR UPDATE
  USING (EXISTS (SELECT 1 FROM decks d WHERE d.id = deck_id AND d.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- card_states
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_states (
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id            UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  pipeline_id        UUID NOT NULL REFERENCES pipelines(id),
  current_step_order INTEGER NOT NULL DEFAULT 0,
  correct_in_step    INTEGER NOT NULL DEFAULT 0,
  graduated          BOOLEAN NOT NULL DEFAULT FALSE,
  due_at             TIMESTAMPTZ,
  interval_days      NUMERIC(10,4) NOT NULL DEFAULT 0,
  ease               NUMERIC(6,4)  NOT NULL DEFAULT 2.5,
  reps               INTEGER NOT NULL DEFAULT 0,
  lapses             INTEGER NOT NULL DEFAULT 0,
  last_rating        TEXT CHECK (last_rating IN ('again','hard','good','easy')),
  last_reviewed_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX card_states_due_at_idx ON card_states(user_id, due_at) WHERE graduated = TRUE;
CREATE TRIGGER card_states_updated_at BEFORE UPDATE ON card_states FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE card_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY "card_states: owner only" ON card_states FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- review_events  (immutable — never update or delete rows)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id      UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL CHECK (mode IN ('recognition','typing')),
  prompt_side  TEXT NOT NULL CHECK (prompt_side IN ('front','back')),
  answer_side  TEXT NOT NULL CHECK (answer_side IN ('front','back')),
  prompt_shown TEXT NOT NULL,
  expected     TEXT NOT NULL,
  user_answer  TEXT NOT NULL DEFAULT '',
  was_correct  BOOLEAN NOT NULL,
  rating       TEXT CHECK (rating IN ('again','hard','good','easy')),
  response_ms  INTEGER,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX review_events_user_card_idx  ON review_events(user_id, card_id);
CREATE INDEX review_events_reviewed_at_idx ON review_events(reviewed_at DESC);
ALTER TABLE review_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "review_events: owner insert" ON review_events FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "review_events: owner select" ON review_events FOR SELECT USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Seed: default pipeline
-- ---------------------------------------------------------------------------
INSERT INTO pipelines (id, owner_id, name, is_default)
VALUES ('00000000-0000-0000-0000-000000000001', NULL, 'Default (Research-Informed)', TRUE);

INSERT INTO pipeline_steps (pipeline_id, step_order, step_type, prompt_side, answer_side, required_correct) VALUES
  ('00000000-0000-0000-0000-000000000001', 0, 'recognition', 'front', 'back',  1),
  ('00000000-0000-0000-0000-000000000001', 1, 'recognition', 'back',  'front', 1),
  ('00000000-0000-0000-0000-000000000001', 2, 'typing',      'back',  'front', 2);

-- ---------------------------------------------------------------------------
-- Auth trigger: auto-create profile on signup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'display_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
