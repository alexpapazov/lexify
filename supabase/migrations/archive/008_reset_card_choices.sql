-- Migration 008: clear cached multiple-choice distractor pools.
--
-- The original /api/distractors prompt sometimes returned distractors in
-- the wrong language for the "back" side (e.g. Spanish options for an
-- English answer). The prompt has been fixed to generate paired
-- translations instead, but any already-cached `choices` data may still
-- contain the bad (wrong-language) options. Clearing it forces the app to
-- regenerate fresh, correct distractors the next time each card is studied.
UPDATE cards SET choices = NULL WHERE choices IS NOT NULL;
