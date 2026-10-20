import type { Sql } from "./db.ts";
import { castFacingName } from "./names.ts";

// Who recorded what. Parts aren't owned: anyone can record any line, so a part is labelled by the
// people whose takes play for it.

export interface RecordedBy {
  kind: "actor" | "director";
  name: string; // a first name: the cast member's, or the director's as the cast sees it
}

/** A part's label: whoever recorded most of its lines, and how many others recorded the rest. */
export interface TopRecorder {
  name: string;
  others: number;
}

interface RecorderFields {
  recordedBy: "actor" | "director";
  actorName: string | null;
  userName: string | null;
  userEmail: string | null;
}

const firstWord = (name: string) => name.trim().split(/\s+/)[0] || name;

export function recorderName(r: RecorderFields): string {
  if (r.recordedBy === "director") return firstWord(castFacingName(r.userName, r.userEmail ?? ""));
  return r.actorName?.trim() || "Someone";
}

export const takeRecorder = (t: RecorderFields): RecordedBy => ({ kind: t.recordedBy, name: recorderName(t) });

interface RecorderCount extends RecorderFields {
  characterId: string;
  lines: number;
  firstAt: Date;
}

// Each part's top recorder, counting the takes that play now (each voice's current take). Ties go
// to whoever recorded first. Parts nobody has recorded are missing from the map.
export async function topRecorders(sql: Sql, productionId: string): Promise<Map<string, TopRecorder>> {
  const rows = await sql<RecorderCount[]>`
    select lv.character_id, t.recorded_by,
      max(coalesce(a.first_name, split_part(a.name, ' ', 1))) as actor_name, max(u.name) as user_name, max(u.email) as user_email,
      count(*)::int as lines, min(t.created_at) as first_at
    from line_voices lv
      join takes t on t.id = voice_take(lv.line_id, lv.shared, lv.character_id)
      left join actors a on a.id = t.actor_id
      left join users u on u.id = t.recorded_by_user_id
    where lv.production_id = ${productionId}
    group by lv.character_id, t.recorded_by, coalesce(t.actor_id, t.recorded_by_user_id)`;
  const byPart = new Map<string, RecorderCount[]>();
  for (const r of rows) byPart.set(r.characterId, [...(byPart.get(r.characterId) ?? []), r]);
  const out = new Map<string, TopRecorder>();
  for (const [id, list] of byPart) {
    const [top] = list.sort((a, b) => b.lines - a.lines || a.firstAt.getTime() - b.firstAt.getTime());
    out.set(id, { name: recorderName(top!), others: list.length - 1 });
  }
  return out;
}

// The parts a director has recorded any line of (a take not deleted, whether or not it still plays).
export async function partsRecordedBy(sql: Sql, productionId: string, userId: string): Promise<Set<string>> {
  const rows = await sql<{ characterId: string }[]>`
    select distinct lv.character_id from line_voices lv join takes t on t.line_id = lv.line_id
    where lv.production_id = ${productionId} and t.deleted_at is null and t.recorded_by = 'director' and t.recorded_by_user_id = ${userId}
      and (not lv.shared or t.character_id = lv.character_id)`;
  return new Set(rows.map((r) => r.characterId));
}
