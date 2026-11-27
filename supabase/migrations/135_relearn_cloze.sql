-- 135: Relearning cards present as cloze in the Due Now runner.
-- A relearn-loop (or matching-remedial) production review shows the word blanked out of a
-- sentence instead of the plain typed prompt. Default ON (user decision 2026-11-26);
-- Settings → Due Now → "Relearning cards" turns it back to the classic review.
alter table profiles add column if not exists relearn_cloze boolean not null default true;
