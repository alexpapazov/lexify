-- 105_reverse_dormancy_backfill.sql
--
-- Dormancy becomes PER-DIRECTION.
--
-- Until now the forward row's `dormant` acted as a master switch: every Due Now surface skipped a
-- card's REVERSE (recognition) row whenever the FORWARD row was dormant. That made the modal's
-- "Resume recognition" button a no-op while the card was dormant — you could flip the reverse flag
-- but the card still never came back.
--
-- The app now gates each direction on its OWN `dormant` flag, so production and recognition can be
-- paused and resumed independently. Without this backfill that change would be a regression: every
-- existing dormant card has reverse.dormant = false (it never needed to be set), so their
-- recognition reviews would all suddenly become due at once.
--
-- This copies the forward row's dormancy onto the reverse row for existing cards, preserving today's
-- effective behavior exactly. Idempotent: only touches reverse rows that are currently not dormant
-- and whose forward counterpart is dormant.

UPDATE card_states AS rev
SET    dormant = true
FROM   card_states AS fwd
WHERE  rev.user_id          = fwd.user_id
  AND  rev.card_id          = fwd.card_id
  AND  rev.review_direction = 'reverse'
  AND  fwd.review_direction = 'forward'
  AND  fwd.dormant          = true
  AND  rev.dormant          = false;
