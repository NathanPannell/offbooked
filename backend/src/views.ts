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

export async function productionRows(sql: Sql, where: { ownerId: string; id?: string; includeArchived?: boolean }): Promise<ProductionRow[]> {
  return sql<ProductionRow[]>`
    select p.id, p.owner_id, p.title, p.performance_date::text as performance_date, p.script_status, p.script_error,
      p.archived_at, p.created_at,
      (select count(*)::int from lines l where l.production_id = p.id and l.kind = 'dialogue') as lines_total,
      (select count(*)::int from lines l where l.production_id = p.id and l.kind = 'dialogue' and l.current_take_id is not null) as lines_recorded,
      (select count(*)::int from actors a where a.production_id = p.id) as actors_total,
      (select count(*)::int from actors a where a.production_id = p.id
        and exists (select 1 from actor_characters ac join lines l on l.character_id = ac.character_id and l.kind = 'dialogue' where ac.actor_id = a.id)
        and not exists (select 1 from actor_characters ac join lines l on l.character_id = ac.character_id and l.kind = 'dialogue'
                        where ac.actor_id = a.id and l.current_take_id is null)) as actors_done
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
}

export const characterView = (c: CharacterRow) => ({ id: c.id, name: c.name, aliases: c.aliases, lineCount: c.lineCount });

export interface LineRow {
  id: string;
  seq: number;
  sectionId: string;
  kind: "dialogue" | "stage_direction" | "heading";
  characterId: string | null;
  text: string;
  flagged: boolean;
  flagReason: string | null;
  currentTakeId: string | null;
  sourceLine: number | null;
  sourcePage: number | null;
}

export const lineView = (l: LineRow) => ({
  id: l.id,
  seq: l.seq,
  sectionId: l.sectionId,
  kind: l.kind,
  characterId: l.characterId,
  text: l.text,
  flagged: l.flagged,
  flagReason: l.flagReason,
  sourceLine: l.sourceLine,
  page: l.sourcePage,
});

export const sectionsOf = (sql: Sql, productionId: string) =>
  sql<SectionRow[]>`select id, seq, act, scene, title from sections where production_id = ${productionId} order by seq`;

export const linesOf = (sql: Sql, productionId: string) =>
  sql<LineRow[]>`select id, seq, section_id, kind, character_id, text, flagged, flag_reason, current_take_id, source_line, source_page
                 from lines where production_id = ${productionId} order by seq`;

export const charactersOf = (sql: Sql, productionId: string) =>
  sql<CharacterRow[]>`
    select c.id, c.name, c.aliases,
      (select count(*)::int from lines l where l.character_id = c.id and l.kind = 'dialogue') as line_count
    from characters c where c.production_id = ${productionId} order by lower(c.name)`;

export interface TakeRow {
  id: string;
  lineId: string;
  storageKey: string;
  durationMs: number;
  createdAt: Date;
  sttTranscript: string | null;
  sttAccuracy: number | null;
  sttOps: unknown[] | null;
}

export async function takeView(storage: Storage, t: TakeRow) {
  return {
    id: t.id,
    lineId: t.lineId,
    audioUrl: await storage.signedUrl(t.storageKey),
    durationMs: t.durationMs,
    createdAt: iso(t.createdAt)!,
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
      (select count(*)::int from lines l join actor_characters ac on ac.character_id = l.character_id
        where ac.actor_id = a.id and l.kind = 'dialogue') as lines_total,
      (select count(*)::int from lines l join actor_characters ac on ac.character_id = l.character_id
        where ac.actor_id = a.id and l.kind = 'dialogue' and l.current_take_id is not null) as lines_recorded,
      (select avg(t.stt_accuracy)::float8 from lines l join actor_characters ac on ac.character_id = l.character_id
        join takes t on t.id = l.current_take_id
        where ac.actor_id = a.id and l.kind = 'dialogue' and t.stt_accuracy is not null) as avg_accuracy
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
