-- Which productions use each synthesized clip. tts_clips is shared by content hash, and a clip is a
-- production's lines spoken aloud (with their text in timings), so when a production's content is
-- deleted the clips no other production uses are deleted with it (tts/cleanup.ts). Recorded as
-- productions use clips (TtsService.cached / ensure); a clip's uses go with it.
create table if not exists tts_clip_uses (
  hash text not null references tts_clips(hash) on delete cascade,
  production_id uuid not null references productions(id),
  primary key (hash, production_id)
);
create index if not exists tts_clip_uses_production on tts_clip_uses (production_id);
