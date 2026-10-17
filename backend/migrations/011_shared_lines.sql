-- Shared lines: a line several characters say together ("ANGELO, ESCALUS", "ALL", "BOTH").
-- A character named after several others, or after the whole company, is a group: never a part to
-- take. Its lines carry voice_ids, the characters who say them; each of their actors records the
-- line and playback mixes the takes. Every other line has voice_ids null (just its character).
alter table characters add column if not exists is_group boolean not null default false;
alter table characters add column if not exists everyone boolean not null default false; -- ALL, BOTH, EVERYONE…
alter table characters add column if not exists member_ids uuid[];                       -- the named characters, in order

alter table lines add column if not exists voice_ids uuid[];
-- names: the group's members. scene: everyone who speaks in the scene, until Claude has read who is
-- on stage (model). director: picked by hand. sync_shared_lines only recomputes names and scene.
alter table lines add column if not exists voices_source text;
alter table lines drop constraint if exists lines_voices_source_check;
alter table lines add constraint lines_voices_source_check check (voices_source in ('names', 'scene', 'model', 'director'));

-- Which voice a take is for on a shared line. Null on older takes and on single-voice lines.
alter table takes add column if not exists character_id uuid references characters(id);

-- Deleting a take hides it: the line goes back to its previous take (or TTS). The audio is kept,
-- like every recording, and the take can be put back.
alter table takes add column if not exists deleted_at timestamptz;

-- A shared line's takes mixed into one clip, keyed by a hash of the takes and the mix settings.
create table if not exists take_mixes (
  hash text primary key,
  production_id uuid not null references productions(id),
  normalized_key text not null,
  stream_key text not null,
  samples int not null,
  created_at timestamptz not null default now()
);

-- Every dialogue line's voices, one row each. `shared` lines match takes to voices by character.
create or replace view line_voices as
  select l.id as line_id, l.production_id, l.section_id, l.seq, v.character_id, v.ord::int as ord, (l.voice_ids is not null) as shared
  from lines l cross join lateral unnest(coalesce(l.voice_ids, array[l.character_id])) with ordinality as v(character_id, ord)
  where l.kind = 'dialogue' and l.character_id is not null;

-- The newest take that voices `voice` on a line: on a single-voice line any take; on a shared line a
-- take recorded for that character, or an actor's take by whoever plays it. `actor_only` leaves out
-- stand-ins (progress counts only the cast's own takes).
create or replace function voice_take(line uuid, shared boolean, voice uuid, actor_only boolean) returns uuid
language sql stable as $$
  select t.id from takes t
  where t.line_id = line and t.deleted_at is null and (not actor_only or t.recorded_by = 'actor')
    and (not shared or t.character_id = voice
         or (t.recorded_by = 'actor' and exists (select 1 from actor_characters ac where ac.actor_id = t.actor_id and ac.character_id = voice)))
  order by t.created_at desc limit 1
$$;

-- Recomputes groups and shared-line voices for one production. Cheap; run after any change to its
-- characters or lines.
create or replace function sync_shared_lines(p uuid) returns void
language plpgsql as $$
begin
  -- A name that now means one character twice ("ESCALUS, ELBOW" after ELBOW was merged into
  -- ESCALUS) is that character.
  update lines l set character_id = d.member, updated_at = now()
  from (
    select c2.id, min(m.id::text)::uuid as member
    from characters c2
      cross join lateral unnest(regexp_split_to_array(trim(c2.name), '\s*(?:,|&|/|\+|\mand\M)\s*', 'i')) as s(part)
      join characters m on m.production_id = p and m.id <> c2.id and not m.is_group
        and (lower(m.name) = lower(trim(s.part)) or lower(trim(s.part)) = any (select lower(a) from unnest(m.aliases) a))
    where c2.production_id = p and c2.is_group and trim(s.part) <> ''
    group by c2.id
    having count(distinct m.id) = 1 and count(*) >= 2
  ) d
  where l.character_id = d.id;
  update characters c set everyone = g.everyone, member_ids = g.members, is_group = g.everyone or g.members is not null
  from (
    select c2.id,
      upper(regexp_replace(trim(c2.name), '[.:]+$', ''))
        ~ '^(ALL|BOTH|EVERYONE|EVERYBODY|OMNES|TOGETHER|ALL TOGETHER|ALL OF THEM|OTHERS|THE OTHERS|ALL THE OTHERS|ALL THREE|ALL FOUR|ALL FIVE|ALL SIX)$' as everyone,
      (select case when count(*) >= 2 and count(*) = count(m.id) and count(distinct m.id) >= 2
                   then array(select x from unnest(array_agg(m.id order by s.ord)) with ordinality as u(x, o) group by x order by min(o)) end
       from unnest(regexp_split_to_array(trim(c2.name), '\s*(?:,|&|/|\+|\mand\M)\s*', 'i')) with ordinality as s(part, ord)
       left join lateral (
         select m.id from characters m
         where m.production_id = p and m.id <> c2.id
           and (lower(m.name) = lower(trim(s.part)) or lower(trim(s.part)) = any (select lower(a) from unnest(m.aliases) a))
         order by m.created_at limit 1) m on true
       where trim(s.part) <> '') as members
    from characters c2 where c2.production_id = p
  ) g
  where c.id = g.id and (c.everyone, c.member_ids, c.is_group) is distinct from (g.everyone, g.members, g.everyone or g.members is not null);

  -- Not spoken by a group (any more): one voice.
  update lines l set voice_ids = null, voices_source = null
  where l.production_id = p and l.voice_ids is not null
    and (l.kind <> 'dialogue' or not exists (select 1 from characters c where c.id = l.character_id and c.is_group));

  -- Named groups: their members.
  update lines l set voice_ids = c.member_ids, voices_source = 'names'
  from characters c
  where c.id = l.character_id and l.production_id = p and l.kind = 'dialogue' and c.member_ids is not null
    and (l.voices_source is null or l.voices_source in ('names', 'scene'))
    and (l.voice_ids is distinct from c.member_ids or l.voices_source is distinct from 'names');

  -- ALL and friends: everyone who speaks in the scene, in order of first line, until Claude has
  -- read the scene for who is on stage.
  update lines l set voice_ids = s.ids, voices_source = 'scene'
  from (
    select l2.id, (
      select array_agg(q.cid order by q.first_seq) from (
        select v.cid, min(x.seq) as first_seq
        from lines x join characters xc on xc.id = x.character_id
          cross join lateral unnest(case when xc.member_ids is not null then xc.member_ids
                                         when xc.is_group then '{}'::uuid[] else array[x.character_id] end) as v(cid)
        where x.section_id = l2.section_id and x.kind = 'dialogue'
        group by v.cid) q) as ids
    from lines l2 join characters c on c.id = l2.character_id
    where l2.production_id = p and l2.kind = 'dialogue' and c.everyone and not (c.member_ids is not null)
      and (l2.voices_source is null or l2.voices_source in ('names', 'scene'))
  ) s
  where l.id = s.id and s.ids is not null and cardinality(s.ids) >= 1
    and (l.voice_ids is distinct from s.ids or l.voices_source is distinct from 'scene');
end
$$;

select sync_shared_lines(id) from productions;
