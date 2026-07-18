-- Learning-ladder session logging: one row per rung attempt, so Analytics can show
-- session stats (time to graduate, time per card) and replay cards climbing the ladder.
create table if not exists ladder_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  session_id      uuid not null,          -- one visit to a ladder study page
  card_id         uuid not null,
  deck_id         uuid,
  label           text,                   -- card front, denormalized for the replay
  source_language text,
  target_language text,
  from_rung       int  not null,          -- rung the card was on when answered
  to_rung         int  not null,          -- rung after the attempt (= rung_count when graduated)
  rung_count      int  not null,          -- ladder length at the time
  rung_type       text,                   -- mcq | typing | self_graded | dictation
  outcome         text,                   -- pass | miss | almost | again | hard | good | easy
  advanced        boolean not null default false,
  graduated       boolean not null default false,
  duration_ms     int,                    -- time the card was on screen before answering
  created_at      timestamptz not null default now()
);

create index if not exists ladder_events_user_created_idx on ladder_events (user_id, created_at desc);
create index if not exists ladder_events_session_idx       on ladder_events (session_id);

alter table ladder_events enable row level security;

drop policy if exists "own ladder_events" on ladder_events;
create policy "own ladder_events" on ladder_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
