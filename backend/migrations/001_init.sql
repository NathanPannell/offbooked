create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  created_at timestamptz not null default now()
);

create table login_tokens (
  token_hash text primary key,
  email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions(user_id);

create table productions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id),
  title text not null,
  performance_date date,
  script_status text not null default 'none' check (script_status in ('none', 'parsing', 'ready', 'failed')),
  script_error text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index productions_owner_idx on productions(owner_id);

create table scripts (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  source_kind text not null check (source_kind in ('pdf', 'text')),
  storage_key text not null,
  raw_text text,
  status text not null default 'parsing' check (status in ('parsing', 'ready', 'failed')),
  error text,
  parser text,
  usage jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index scripts_production_idx on scripts(production_id, created_at desc);

create table sections (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  seq int not null,
  act text,
  scene text,
  title text not null
);
create index sections_production_idx on sections(production_id, seq);

create table characters (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  name text not null,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);
create unique index characters_name_idx on characters(production_id, lower(name));

create table lines (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  section_id uuid not null references sections(id),
  seq int not null,
  kind text not null check (kind in ('dialogue', 'stage_direction', 'heading')),
  character_id uuid references characters(id),
  text text not null,
  flagged boolean not null default false,
  flag_reason text,
  current_take_id uuid,
  updated_at timestamptz not null default now(),
  constraint lines_seq_unique unique (production_id, seq) deferrable initially deferred,
  constraint lines_dialogue_character check (kind <> 'dialogue' or character_id is not null)
);
create index lines_character_idx on lines(character_id);
create index lines_section_idx on lines(section_id);

create table actors (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  name text not null,
  email text,
  phone text,
  token_version int not null default 1,
  first_name text,
  opened_at timestamptz,
  last_active_at timestamptz,
  nudged_at timestamptz,
  created_at timestamptz not null default now()
);
create index actors_production_idx on actors(production_id);

create table actor_characters (
  actor_id uuid not null references actors(id),
  character_id uuid not null references characters(id) unique,
  primary key (actor_id, character_id)
);

create table takes (
  id uuid primary key,
  production_id uuid not null references productions(id),
  line_id uuid not null references lines(id),
  actor_id uuid not null references actors(id),
  storage_key text not null,
  content_type text not null,
  bytes int not null,
  duration_ms int not null,
  normalized_key text,
  normalized_samples int,
  stt_transcript text,
  stt_accuracy real,
  stt_ops jsonb,
  created_at timestamptz not null default now()
);
create index takes_line_idx on takes(line_id);
create index takes_actor_idx on takes(actor_id);
alter table lines add constraint lines_current_take_fk foreign key (current_take_id) references takes(id);

create table renders (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  status text not null check (status in ('queued', 'rendering', 'ready', 'failed')),
  forced boolean not null default false,
  run_after timestamptz not null default now(),
  content_hash text,
  storage_key text,
  duration_ms int,
  timing jsonb,
  take_ids uuid[],
  all_recorded boolean,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index renders_production_idx on renders(production_id, created_at desc);
create unique index renders_one_queued on renders(production_id) where status = 'queued';
create unique index renders_one_running on renders(production_id) where status = 'rendering';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  production_id uuid not null references productions(id),
  actor_id uuid references actors(id),
  recipient text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  constraint notifications_once unique nulls not distinct (kind, production_id, actor_id)
);

create table email_unsubscribes (
  email text primary key,
  created_at timestamptz not null default now()
);

create table practice_runs (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id),
  actor_id uuid not null references actors(id),
  mode text not null,
  results jsonb not null,
  avg_accuracy real,
  created_at timestamptz not null default now()
);

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);
