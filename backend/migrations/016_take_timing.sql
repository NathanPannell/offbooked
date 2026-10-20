-- Word timing for takes, so the run-through lights up words as a take really says them.
-- speech_ms: where the voice is in the served clip (the normalized, trimmed .m4a), as flat
--   [start, end, start, end, …] pairs in ms, found from the clip's own frame levels when it is
--   normalized (render/trim.ts). Empty when the clip has no clear speech; null until worked out
--   (takes normalized before this are done once, on their next playback).
-- trim_start_ms: where the served clip starts in the uploaded recording (the trim's cut).
-- word_starts_ms: when each spoken word starts, in ms of the uploaded recording, as the app heard
--   them while the take recorded (X-Word-Starts). Shifted by trim_start_ms when served.
alter table takes add column if not exists speech_ms integer[];
alter table takes add column if not exists trim_start_ms integer;
alter table takes add column if not exists word_starts_ms integer[];
