-- Step 3 (type English from Spanish prompt) only needs 1 correct answer,
-- not 2. Step 2 (type Spanish from English prompt) stays at 2.
UPDATE pipeline_steps
SET required_correct = 1
WHERE pipeline_id = '00000000-0000-0000-0000-000000000001'
  AND step_order = 3;
