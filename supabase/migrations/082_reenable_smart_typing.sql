-- 082_reenable_smart_typing.sql
--
-- Corrective: migration 078 was not safe to re-run — a second run read
-- forward_typed_enabled AFTER it had been set false, flipping forward_smart_enabled
-- back to false. That disables the whole production lane (typed off + smart off), so
-- production cards vanish from Due Now, the forecast, and the counts.
--
-- Re-enable the smart-typing track wherever typed production is disabled (i.e. the
-- pair was migrated to smart). Safe to run repeatedly.

UPDATE user_scheduler_params s
SET forward_smart_enabled = true
WHERE s.answer_field = 'forward_smart'
  AND EXISTS (
    SELECT 1 FROM user_scheduler_params t
    WHERE t.user_id = s.user_id
      AND t.source_language = s.source_language
      AND t.target_language = s.target_language
      AND t.answer_field = 'forward_typed'
      AND t.forward_typed_enabled = false
  );
