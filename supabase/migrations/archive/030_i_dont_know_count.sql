-- Track how many times the learner pressed "I don't know" on each card.
ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS i_dont_know_count INTEGER NOT NULL DEFAULT 0;
