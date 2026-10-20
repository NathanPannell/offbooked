-- Parts aren't owned. Anyone can pick any part and record any line; picking a part only says what
-- you mean to record. A director's takes are ordinary takes: they play, and they count towards
-- progress and completion like anyone's (there are no stand-ins any more).
alter table actor_characters drop constraint if exists actor_characters_character_id_key;
create index if not exists actor_characters_character_idx on actor_characters (character_id);

alter table takes drop constraint if exists takes_recorder;
alter table takes drop constraint if exists takes_recorded_by_check;
-- Stand-ins become the director's takes, and so do takes recorded through the director's own cast
-- member (the old "record a part yourself" link).
update takes set recorded_by = 'director' where recorded_by = 'standin';
update takes t set recorded_by = 'director', recorded_by_user_id = a.director_user_id, actor_id = null
from actors a where a.id = t.actor_id and a.director_user_id is not null;
-- That cast member's picks go too: the director records in the studio, and a part counts as picked
-- (for cast completion) only when someone in the cast picked it.
delete from actor_characters ac using actors a where a.id = ac.actor_id and a.director_user_id is not null;
alter table takes add constraint takes_recorded_by_check check (recorded_by in ('actor', 'director'));
alter table takes add constraint takes_recorder check (
  (recorded_by = 'actor' and actor_id is not null) or (recorded_by = 'director' and recorded_by_user_id is not null));
drop index if exists takes_line_actor_idx;

-- The newest take that voices `voice` on a line: on a single-voice line any take; on a shared line a
-- take recorded for that character, or an actor take by someone who picked it (one take can voice
-- several of a line's characters when the same person picked them; mix.ts plays it once).
-- Replaces voice_take(line, shared, voice, actor_only): every take counts now. The old one stays
-- until the next migration so the container still serving during a deploy keeps working.
create or replace function voice_take(line uuid, shared boolean, voice uuid) returns uuid
language sql stable as $$
  select t.id from takes t
  where t.line_id = line and t.deleted_at is null
    and (not shared or t.character_id = voice
         or (t.recorded_by = 'actor' and exists (select 1 from actor_characters ac where ac.actor_id = t.actor_id and ac.character_id = voice)))
  order by t.created_at desc limit 1
$$;
