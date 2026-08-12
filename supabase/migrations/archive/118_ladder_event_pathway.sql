-- Pathway-aware session logging. Pathway attempts were logged with from_rung = to_rung = 0 (a
-- RouteState has no rung index), so Analytics replays had nothing to animate. Events now record the
-- card's position as the STATE INDEX in the pathway's state list, whether it was a pathway attempt,
-- and the landed state's display name (lane labels in the replay — historically accurate even after
-- the pathway is edited).
alter table ladder_events add column if not exists pathway boolean not null default false;
alter table ladder_events add column if not exists state_name text;
