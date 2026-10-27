import type { Sql } from "../db.ts";
import { actorKey, memberships, takesWithPerson, userKey } from "./people.ts";

// Everyone who has recorded a take, grouped into people (people.ts): cast members and directors.
// `takes` and `linesRecorded` count takes that haven't been deleted; the first and last recording
// count every take. Last seen: a cast member's last request on their link (actors.last_active_at),
// a director's last sign-in, or their last recording, whichever is latest.

export interface Recorder {
  person: string;
  name: string | null;
  email: string | null;
  director: boolean;
  takes: number;
  linesRecorded: number;
  firstRecordingAt: Date;
  lastRecordingAt: Date;
  lastSeenAt: Date;
  productions: { id: string; title: string; role: "owner" | "cast" }[];
}

export async function adminRecorders(sql: Sql): Promise<Recorder[]> {
  return sql<Recorder[]>`
    with tp as ${takesWithPerson(sql)},
    rec as (
      select person, count(*) filter (where deleted_at is null)::int as takes,
        count(distinct line_id) filter (where deleted_at is null)::int as lines_recorded,
        min(created_at) as first_recording_at, max(created_at) as last_recording_at,
        (array_agg(name order by created_at desc) filter (where name is not null))[1] as name,
        (array_agg(email order by created_at desc) filter (where email is not null))[1] as email,
        bool_or(recorded_by = 'director') as director
      from tp group by person
    ), seen as (
      select ${actorKey(sql)} as person, max(a.last_active_at) as at from actors a left join users du on du.id = a.director_user_id group by 1
      union all
      select ${userKey(sql)}, max(s.created_at) from sessions s join users u on u.id = s.user_id group by 1
      union all
      select 'e:' || lower(email), max(used_at) from login_tokens where used_at is not null group by 1
    ), last_seen as (
      select person, max(at) as at from seen group by person
    ), ms as (
      select m.person, json_agg(json_build_object('id', p.id, 'title', p.title, 'role', m.role) order by p.created_at) as productions
      from (select person, production_id, max(role) as role from ${memberships(sql)} mm group by person, production_id) m
        join productions p on p.id = m.production_id
      where m.person in (select person from rec)
      group by m.person
    )
    select rec.person, rec.name, rec.email, rec.director, rec.takes, rec.lines_recorded, rec.first_recording_at, rec.last_recording_at,
      greatest(rec.last_recording_at, ls.at) as last_seen_at, coalesce(ms.productions, '[]'::json) as productions
    from rec left join ms on ms.person = rec.person left join last_seen ls on ls.person = rec.person
    order by rec.last_recording_at desc, rec.person`;
}

export const recorderView = (r: Recorder) => ({
  key: r.person,
  name: r.name,
  email: r.email,
  kind: r.director ? ("director" as const) : ("cast" as const),
  takes: r.takes,
  linesRecorded: r.linesRecorded,
  firstRecordingAt: r.firstRecordingAt.toISOString(),
  lastRecordingAt: r.lastRecordingAt.toISOString(),
  lastSeenAt: r.lastSeenAt.toISOString(),
  productions: r.productions,
});
