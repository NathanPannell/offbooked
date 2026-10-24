import type { Sql } from "../db.ts";
import type { Storage } from "../storage/storage.ts";
import type { TtsService } from "./service.ts";
import { speakableDirection, spokenParts } from "./voices.ts";

// Synthesized speech is shared across productions by content hash (tts_clips), and every clip is
// some production's lines read aloud, with their text kept in timings for word highlighting. So
// when a production's content is deleted (retention.ts: after its final performance, or with its
// director's account), the clips it used are deleted too, files and rows, unless another live
// production still uses them. A clip is this production's when any of these holds:
// - it is recorded as used by it (tts_clip_uses);
// - it is what one of its lines is synthesized as now (the same hash the player asks for);
// - it speaks one of its lines' printed lines (timings), which finds clips made under older engines
//   or settings that nothing records;
// - it has no timings at all. Those were made before clips recorded their text (migration 010) and
//   before settings version 3, so no current hash can ever ask for them again.
// Keeping a clip needs a recorded use by another production whose content is still there. Deleting
// one that another production happens to share but never recorded (identical text, same voice) is
// harmless: it is synthesized again the next time that production asks for it.

interface ClipFiles {
  hash: string;
  storageKey: string;
  cueKey: string | null;
}

/** The printed lines a production's lines are spoken as, the text a clip's timings hold. */
export function spokenPieces(lines: { kind: string; text: string }[]): string[] {
  const pieces = new Set<string>();
  for (const l of lines) {
    const said = l.kind === "stage_direction" ? [speakableDirection(l.text)] : spokenParts(l.text).map((p) => p.text);
    for (const text of said) for (const piece of text.split("\n")) if (piece.trim()) pieces.add(piece);
  }
  return [...pieces];
}

/** Hashes this production's lines would be synthesized as now, or none when TTS can't run here. */
async function currentHashes(sql: Sql, tts: TtsService | null, productionId: string): Promise<string[]> {
  const engine = tts ? await tts.engine() : null;
  if (!tts || !engine) return [];
  const voices = await tts.voices(productionId);
  const lines = await sql<{ kind: string; characterId: string | null; text: string }[]>`
    select kind, character_id, text from lines where production_id = ${productionId} and kind in ('dialogue', 'stage_direction')`;
  return lines.flatMap((l) => {
    const r = l.kind === "stage_direction" ? tts.directionRequest(engine, l.text) : tts.request(engine, voices.get(l.characterId ?? ""), l.text);
    return r ? [r.hash] : [];
  });
}

/**
 * Deletes the clips only this production uses (see above). Run before its lines are deleted, since
 * they say which clips are its. Files first, then rows: a failure leaves the rows, so the next pass
 * finds the same clips again. Returns how many storage objects went.
 */
export async function deleteProductionClips(deps: { sql: Sql; storage: Storage; tts: TtsService | null }, productionId: string): Promise<number> {
  const { sql } = deps;
  const lines = await sql<{ kind: string; text: string }[]>`
    select kind, text from lines where production_id = ${productionId} and kind in ('dialogue', 'stage_direction')`;
  const pieces = spokenPieces(lines);
  const hashes = await currentHashes(sql, deps.tts, productionId);
  const clips = await sql<ClipFiles[]>`
    select c.hash, c.storage_key, c.cue_key from tts_clips c
    where (c.timings is null
        or c.hash = any(${hashes}::text[])
        or exists (select 1 from tts_clip_uses u where u.hash = c.hash and u.production_id = ${productionId})
        or exists (select 1 from jsonb_array_elements(c.timings) s where s->>'text' = any(${pieces}::text[])))
      and not exists (
        select 1 from tts_clip_uses u join productions p on p.id = u.production_id join users o on o.id = p.owner_id
        where u.hash = c.hash and u.production_id <> ${productionId} and p.content_deleted_at is null and o.deleted_at is null)`;
  return deleteClips(deps, clips);
}

/** Deletes these clips, files then rows. */
async function deleteClips(deps: { sql: Sql; storage: Storage }, clips: ClipFiles[]): Promise<number> {
  if (!clips.length) return 0;
  const keys = clips.flatMap((c) => (c.cueKey ? [c.storageKey, c.cueKey] : [c.storageKey]));
  const objects = await deps.storage.deleteKeys(keys);
  await deps.sql`delete from tts_clips where hash = any(${clips.map((c) => c.hash)}::text[])`;
  return objects;
}

/**
 * A clip made for a production whose content was deleted meanwhile (its synthesis was already
 * running): deleted at once unless another live production uses it, like any other of its clips.
 */
export async function deleteClipsOfDeleted(deps: { sql: Sql; storage: Storage }, productionId: string, hashes: string[]): Promise<number> {
  const clips = await deps.sql<ClipFiles[]>`
    select c.hash, c.storage_key, c.cue_key from tts_clips c
    where c.hash = any(${hashes}::text[])
      and not exists (
        select 1 from tts_clip_uses u join productions p on p.id = u.production_id join users o on o.id = p.owner_id
        where u.hash = c.hash and u.production_id <> ${productionId} and p.content_deleted_at is null and o.deleted_at is null)`;
  return deleteClips(deps, clips);
}
