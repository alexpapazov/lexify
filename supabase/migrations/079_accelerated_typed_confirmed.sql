-- 079_accelerated_typed_confirmed.sql
--
-- Accelerated (import-known) cards are words you already know, so one correct typed
-- production review is enough to confirm them — after that they switch to self-graded
-- (no more typing), regardless of the smart-typing threshold. This flag records that
-- confirmation. Set true the first time such a card is answered correctly while typed.

ALTER TABLE card_states
  ADD COLUMN IF NOT EXISTS accelerated_typed_confirmed boolean NOT NULL DEFAULT false;
