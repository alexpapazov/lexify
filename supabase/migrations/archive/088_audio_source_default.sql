-- Global default audio source per user: 'browser' (robotic device voice, the default — no clip
-- generation), 'elevenlabs' (AI voice), or 'forvo' (real recordings, falling back to AI).
-- Supersedes the earlier prefer_forvo boolean; carry a true prefer_forvo over to 'forvo'.
alter table profiles
  add column if not exists audio_source_default text not null default 'browser';

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'profiles' and column_name = 'prefer_forvo') then
    update profiles set audio_source_default = 'forvo'
      where prefer_forvo = true and audio_source_default = 'browser';
  end if;
end $$;
