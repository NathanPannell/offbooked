import type { FlagCode } from "./parse/flags.ts";
import type { Config } from "./config.ts";
import type { Sql } from "./db.ts";
import { inviteUrl } from "./invite.ts";
import type { Storage } from "./storage/storage.ts";

// Database rows (camelCased by the postgres transform) and their API shapes from docs/api.md.

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface ProductionRow {
  id: string;
  ownerId: string;
  title: string;
  performanceDate: string | null;
  scriptStatus: "none" | "parsing" | "ready" | "failed";
  scriptError: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  linesTotal: number;
  linesRecorded: number;
  actorsTotal: number;
  actorsDone: number;
}

// Progress counts a line as recorded once the cast has a take for each of its voices (one voice,
// or every character who says a shared line). Stand-in takes and TTS fill the run-through but never
// count. line_voices and voice_take are in migrations/011_shared_lines.sql.
const lineRecorded = (sql: Sql) => sql`not exists (select 1 from line_voices v where v.line_id = l.id and voice_take(v.line_id, v.shared, v.character_id, true) is null)`;
const voiceRecorded = (sql: Sql) => sql`voice_take(lv.line_id, lv.shared, lv.character_id, true) is not null`;

export async function productionRows(sql: Sql, where: { ownerId: string; id?: string; includeArchived?: boolean }): Promise<ProductionRow[]> {
  return sql<ProductionRow[]>`
    select p.id, p.owner_id, p.title, p.performance_date::text as performance_date, p.script_status, p.script_error,
      p.archived_at, p.created_at,
      (select count(*)::int from lines l where l.production_id = p.id and l.kind = 'dialogue') as lines_total,
      (select count(*)::int from lines l where l.production_id = p.id and l.kind = 'dialogue' and ${lineRecorded(sql)}) as lines_recorded,
      (select count(*)::int from actors a where a.production_id = p.id) as actors_total,
      (select count(*)::int from actors a where a.production_id = p.id
        and exists (select 1 from actor_characters ac join line_voices lv on lv.character_id = ac.character_id where ac.actor_id = a.id)
        and not exists (select 1 from actor_characters ac join line_voices lv on lv.character_id = ac.character_id
                        where ac.actor_id = a.id and not ${voiceRecorded(sql)})) as actors_done
    from productions p
    where p.owner_id = ${where.ownerId}
      ${where.id ? sql`and p.id = ${where.id}` : sql``}
      ${where.includeArchived ? sql`` : sql`and p.archived_at is null`}
    order by p.created_at desc`;
}

export function productionView(p: ProductionRow) {
  return {
    id: p.id,
    title: p.title,
    performanceDate: p.performanceDate,
    createdAt: iso(p.createdAt)!,
    archived: Boolean(p.archivedAt),
    scriptStatus: p.scriptStatus,
    progress: { linesTotal: p.linesTotal, linesRecorded: p.linesRecorded, actorsTotal: p.actorsTotal, actorsDone: p.actorsDone },
  };
}

export interface SectionRow {
  id: string;
  seq: number;
  act: string | null;
  scene: string | null;
  title: string;
}

export const sectionView = (s: SectionRow) => ({ id: s.id, seq: s.seq, act: s.act, scene: s.scene, title: s.title });

export interface CharacterRow {
  id: string;
  name: string;
  aliases: string[];
  lineCount: number;
  isGroup: boolean;
  everyone: boolean;
  memberIds: string[] | null;
}

// A group ("ANGELO, ESCALUS", "ALL") is a label for shared lines, never a part to take. lineCount
// counts the lines a character says, shared ones included; a group's counts the lines it labels.
export const characterView = (c: CharacterRow) => ({
  id: c.id,
  name: c.name,
  aliases: c.aliases,
  lineCount: c.lineCount,
  group: c.isGroup,
  everyone: c.everyone,
  memberIds: c.memberIds ?? [],
});

export interface LineRow {
  id: string;
  seq: number;
  sectionId: string;
  kind: "dialogue" | "stage_direction" | "heading";
  characterId: string | null;
  text: string;
  flagged: boolean;
  flagCode: FlagCode | null;
  flagReason: string | null;
  currentTakeId: string | null;
  sourceLine: number | null;
  sourcePage: number | null;
  voiceIds: string[] | null; // a shared line's voices; null for one voice (the character)
}

export const voicesOf = (l: Pick<LineRow, "voiceIds" | "characterId">): string[] => l.voiceIds ?? (l.characterId ? [l.characterId] : []);

export const lineView = (l: LineRow) => ({
  id: l.id,
  seq: l.seq,
  sectionId: l.sectionId,
  kind: l.kind,
  characterId: l.characterId,
  text: l.text,
  flagged: l.flagged,
  flagCode: l.flagged ? l.flagCode : null, // one of FLAG_CODES; FLAG_LABELS has the text to show
  flagReason: l.flagged ? l.flagReason : null,
  sourceLine: l.sourceLine,
  page: l.sourcePage,
  voiceIds: l.voiceIds, // who says a shared line, in order; null when only characterId does
});

export const sectionsOf = (sql: Sql, productionId: string) =>
  sql<SectionRow[]>`select id, seq, act, scene, title from sections where production_id = ${productionId} order by seq`;

export const linesOf = (sql: Sql, productionId: string) =>
  sql<LineRow[]>`select id, seq, section_id, kind, character_id, text, flagged, flag_code, flag_reason, current_take_id, source_line, source_page, voice_ids
                 from lines where production_id = ${productionId} order by seq`;

export const charactersOf = (sql: Sql, productionId: string) =>
  sql<CharacterRow[]>`
    select c.id, c.name, c.aliases, c.is_group, c.everyone, c.member_ids,
      case when c.is_group then (select count(*)::int from lines l where l.character_id = c.id and l.kind = 'dialogue')
           else (select count(*)::int from line_voices lv where lv.character_id = c.id) end as line_count
    from characters c where c.production_id = ${productionId} order by lower(c.name)`;

export interface TakeRow {
  id: string;
  lineId: string;
  recordedBy: "actor" | "standin";
  storageKey: string;
  durationMs: number;
  createdAt: Date;
  sttTranscript: string | null;
  sttAccuracy: number | null;
  sttOps: unknown[] | null;
}

export const takeColumns = (sql: Sql) => sql`id, line_id, recorded_by, storage_key, duration_ms, created_at, stt_transcript, stt_accuracy, stt_ops`;

export async function takeView(storage: Storage, t: TakeRow) {
  return {
    id: t.id,
    lineId: t.lineId,
    audioUrl: await storage.signedUrl(t.storageKey),
    durationMs: t.durationMs,
    createdAt: iso(t.createdAt)!,
    recordedBy: t.recordedBy,
    stt: t.sttTranscript !== null && t.sttAccuracy !== null ? { transcript: t.sttTranscript, accuracy: t.sttAccuracy, ops: t.sttOps ?? [] } : null,
  };
}

export interface CastRow {
  id: string;
  productionId: string;
  name: string;
  email: string | null;
  phone: string | null;
  tokenVersion: number;
  firstName: string | null;
  openedAt: Date | null;
  lastActiveAt: Date | null;
  nudgedAt: Date | null;
  createdAt: Date;
  characterIds: string[];
  linesTotal: number;
  linesRecorded: number;
  avgAccuracy: number | null;
}

export async function castRows(sql: Sql, where: { productionId: string; actorId?: string }): Promise<CastRow[]> {
  return sql<CastRow[]>`
    select a.id, a.production_id, a.name, a.email, a.phone, a.token_version, a.first_name, a.opened_at, a.last_active_at, a.nudged_at, a.created_at,
      array(select ac.character_id from actor_characters ac join characters c on c.id = ac.character_id
            where ac.actor_id = a.id order by lower(c.name)) as character_ids,
      (select count(distinct lv.line_id)::int from line_voices lv join actor_characters ac on ac.character_id = lv.character_id
        where ac.actor_id = a.id) as lines_total,
      (select count(distinct lv.line_id)::int from line_voices lv join actor_characters ac on ac.character_id = lv.character_id
        where ac.actor_id = a.id and ${voiceRecorded(sql)}) as lines_recorded,
      (select avg(t.stt_accuracy)::float8 from line_voices lv join actor_characters ac on ac.character_id = lv.character_id
        join takes t on t.id = voice_take(lv.line_id, lv.shared, lv.character_id, true)
        where ac.actor_id = a.id and t.stt_accuracy is not null) as avg_accuracy
    from actors a
    where a.production_id = ${where.productionId} ${where.actorId ? sql`and a.id = ${where.actorId}` : sql``}
    order by a.created_at, a.id`;
}

export function castStatus(a: Pick<CastRow, "openedAt" | "linesTotal" | "linesRecorded">): "not_opened" | "opened" | "in_progress" | "done" {
  if (a.linesTotal > 0 && a.linesRecorded >= a.linesTotal) return "done";
  if (a.linesRecorded > 0) return "in_progress";
  return a.openedAt ? "opened" : "not_opened";
}

export function castMemberView(config: Config, a: CastRow) {
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    phone: a.phone,
    characterIds: a.characterIds,
    inviteUrl: inviteUrl(config.appUrl, config.inviteSecret, a.id, a.tokenVersion),
    status: castStatus(a),
    linesTotal: a.linesTotal,
    linesRecorded: a.linesRecorded,
    firstName: a.firstName,
    lastActiveAt: iso(a.lastActiveAt),
    nudgedAt: iso(a.nudgedAt),
    avgAccuracy: a.avgAccuracy,
  };
}
