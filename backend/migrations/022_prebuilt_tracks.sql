-- Listen tracks built ahead of time (src/track/prebuild.ts): the full read and each cast member's
-- default "Pause, then read", made when the script, a take or the cast changes, so the first play
-- can start on one file. `prebuilt` marks the tracks the prebuild keeps current (they aren't pruned
-- for disuse); `served_at` is when a player was first given the track, so a prebuilt track nobody
-- was given can be deleted as soon as it is out of date.
alter table listen_tracks add column if not exists prebuilt boolean not null default false;
alter table listen_tracks add column if not exists served_at timestamptz;
