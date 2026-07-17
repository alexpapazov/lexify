-- 092_avatars.sql
--
-- Profile pictures: a public "avatars" storage bucket + an avatar_url column on
-- profiles. Each user may only write/replace/delete files under their own
-- `<user_id>/…` prefix; anyone may read (public bucket) so the URL renders in the nav.
--
-- Upload convention (client): path `${user_id}/avatar`, upsert=true, so each user
-- keeps exactly one file; the app cache-busts the public URL with a ?v= query.

-- ── Column ───────────────────────────────────────────────────────────────────
alter table profiles add column if not exists avatar_url text;

-- ── Bucket ───────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- ── RLS policies on storage.objects, scoped to the avatars bucket ────────────
-- Public read.
drop policy if exists "Avatar images are publicly readable" on storage.objects;
create policy "Avatar images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- A user may upload only into their own `<uid>/…` folder.
drop policy if exists "Users upload their own avatar" on storage.objects;
create policy "Users upload their own avatar"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- …replace it (upsert overwrites → UPDATE on storage.objects).
drop policy if exists "Users update their own avatar" on storage.objects;
create policy "Users update their own avatar"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- …and delete it (remove photo).
drop policy if exists "Users delete their own avatar" on storage.objects;
create policy "Users delete their own avatar"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
