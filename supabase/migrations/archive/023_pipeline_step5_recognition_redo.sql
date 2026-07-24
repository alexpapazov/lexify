-- Add a 5th pipeline step to the default pipeline: after graduating typing
-- (front -> back, "type the basis-language word"), the learner does one
-- more Spanish -> English multiple-choice recognition check before the card
-- is considered fully learned.
INSERT INTO pipeline_steps (pipeline_id, step_order, step_type, prompt_side, answer_side, required_correct)
VALUES ('00000000-0000-0000-0000-000000000001', 4, 'recognition', 'front', 'back', 1)
ON CONFLICT (pipeline_id, step_order) DO NOTHING;
