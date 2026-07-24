-- Migration 019: long-term remembering algorithm — lapse clustering.
--
-- Adds the bookkeeping fields the new adaptive scheduler (engine/scheduler.ts)
-- needs to detect "close together" wrong answers on graduated cards and
-- escalate the interval penalty / send the card back to relearning.

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS lapse_cluster_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_lapse_at timestamptz;
