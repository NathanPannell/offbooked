-- Listen tracks (src/track/): a stretch of the listen-through joined into one .m4a for one listener's
-- part and mode, so the website can keep playing with the phone locked (one <audio> source instead
-- of a new one for every line). Keyed by a hash of everything that goes into it, so a new take or
-- an edited line makes a new one. Built in-process on request; unused ones are pruned after 12 hours,
-- and the retention job deletes the rest with the production's content.
create table if not exists listen_tracks (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  hash text not null,
  status text not null check (status in ('building', 'ready', 'failed')),
  storage_key text,
  duration_ms int,
  items jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  used_at timestamptz not null default now(),
  unique (production_id, hash)
);
create index if not exists listen_tracks_used_idx on listen_tracks(production_id, used_at);
