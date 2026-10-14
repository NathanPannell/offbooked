-- Stand-in takes: the director can record any line for a scene partner. They belong to no actor.
alter table takes add column recorded_by text not null default 'actor' check (recorded_by in ('actor', 'standin'));
alter table takes add column recorded_by_user_id uuid references users(id);
alter table takes alter column actor_id drop not null;
alter table takes add constraint takes_recorder check (
  (recorded_by = 'actor' and actor_id is not null) or (recorded_by = 'standin' and recorded_by_user_id is not null));
-- Progress counts lines that have a take by the cast actor.
create index takes_line_actor_idx on takes(line_id) where recorded_by = 'actor';

-- Synthesized speech for lines nobody has recorded yet. Keyed by a hash of (text, voice, settings),
-- shared across productions, kept forever like takes.
create table tts_clips (
  hash text primary key,
  voice text not null,
  storage_key text not null,  -- normalized 48 kHz mono FLAC, the render input
  samples int not null,
  cue_key text,               -- AAC .m4a for cue playback, made on first use
  created_at timestamptz not null default now()
);
