-- 093_onboarding.sql
--
-- First-run setup wizard flag. New users start at false and are sent through the
-- onboarding wizard once; existing users (anyone who already has a language pair)
-- are marked complete so they're never interrupted.

alter table profiles add column if not exists onboarding_completed boolean not null default false;

-- Backfill: treat everyone with existing learning content as already onboarded.
update profiles p
set onboarding_completed = true
where exists (
  select 1 from language_pairs lp where lp.owner_id = p.user_id
);
