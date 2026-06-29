-- Per-user, per-language-pair, per-direction SRS calibration parameters.
-- answer_field values: 'forward_typed', 'forward_recall', 'reverse_recall', 'standard' (legacy)
-- Future Chinese/Korean fields: 'char_typed', 'pinyin_typed', 'char_recall', etc.
CREATE TABLE user_scheduler_params (
  user_id              UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  source_language      TEXT NOT NULL,
  target_language      TEXT NOT NULL,
  answer_field         TEXT NOT NULL DEFAULT 'standard',

  -- Normal track multipliers [min, ideal, max] + floor
  good_min             REAL NOT NULL DEFAULT 2.00,
  good_ideal           REAL NOT NULL DEFAULT 2.25,
  good_max             REAL NOT NULL DEFAULT 2.50,
  good_floor           REAL NOT NULL DEFAULT 1.15,
  hard_min             REAL NOT NULL DEFAULT 1.10,
  hard_ideal           REAL NOT NULL DEFAULT 1.20,
  hard_max             REAL NOT NULL DEFAULT 1.30,
  hard_floor           REAL NOT NULL DEFAULT 1.00,
  easy_min             REAL NOT NULL DEFAULT 3.00,
  easy_ideal           REAL NOT NULL DEFAULT 3.50,
  easy_max             REAL NOT NULL DEFAULT 4.00,
  easy_floor           REAL NOT NULL DEFAULT 1.25,

  -- Accelerated track multipliers (same structure, higher defaults)
  accel_good_min       REAL NOT NULL DEFAULT 2.50,
  accel_good_ideal     REAL NOT NULL DEFAULT 3.00,
  accel_good_max       REAL NOT NULL DEFAULT 3.50,
  accel_hard_min       REAL NOT NULL DEFAULT 1.30,
  accel_hard_ideal     REAL NOT NULL DEFAULT 1.50,
  accel_hard_max       REAL NOT NULL DEFAULT 1.70,
  accel_easy_min       REAL NOT NULL DEFAULT 4.00,
  accel_easy_ideal     REAL NOT NULL DEFAULT 5.00,
  accel_easy_max       REAL NOT NULL DEFAULT 6.00,

  -- Typing probability thresholds
  typed_prob_below_70  REAL NOT NULL DEFAULT 1.00,
  typed_prob_70_to_84  REAL NOT NULL DEFAULT 0.70,
  typed_prob_85_to_94  REAL NOT NULL DEFAULT 0.35,
  typed_prob_95_plus   REAL NOT NULL DEFAULT 0.15,

  -- Shared scheduling constants
  decay_constant_days  REAL NOT NULL DEFAULT 90,
  again_reduction      REAL NOT NULL DEFAULT 0.60,
  max_interval_days    INT  NOT NULL DEFAULT 1460,

  -- Graduation intervals by pipeline struggle count (min/max days)
  grad_interval_0err_min  INT NOT NULL DEFAULT 4,
  grad_interval_0err_max  INT NOT NULL DEFAULT 6,
  grad_interval_1err_min  INT NOT NULL DEFAULT 3,
  grad_interval_1err_max  INT NOT NULL DEFAULT 4,
  grad_interval_2err_min  INT NOT NULL DEFAULT 2,
  grad_interval_2err_max  INT NOT NULL DEFAULT 3,
  grad_interval_3err_min  INT NOT NULL DEFAULT 1,
  grad_interval_3err_max  INT NOT NULL DEFAULT 2,

  -- Calibration tracking state
  calibrated_at           TIMESTAMPTZ,
  total_due_reviews       INT  NOT NULL DEFAULT 0,
  recent_retention_rate   REAL,

  -- Per-language active review combination flags
  forward_typed_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  forward_recall_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  reverse_recall_enabled  BOOLEAN NOT NULL DEFAULT TRUE,

  PRIMARY KEY (user_id, source_language, target_language, answer_field)
);

ALTER TABLE user_scheduler_params ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON user_scheduler_params
  FOR ALL USING (auth.uid() = user_id);

-- Version history: snapshot stored every time calibration changes any values.
CREATE TABLE user_scheduler_params_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  source_language  TEXT NOT NULL,
  target_language  TEXT NOT NULL,
  answer_field     TEXT NOT NULL,
  snapshot         JSONB NOT NULL,
  snapshotted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_due_reviews INT NOT NULL DEFAULT 0
);

ALTER TABLE user_scheduler_params_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON user_scheduler_params_history
  FOR ALL USING (auth.uid() = user_id);
