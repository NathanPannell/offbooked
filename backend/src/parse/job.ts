import { randomUUID } from "node:crypto";
import { ContentDeletedError, sweepIfDeleted } from "../retention.ts";
import { inferInBackground } from "../shared.ts";
import type { Ctx } from "../context.ts";
import type { Tx } from "../db.ts";
import { ScriptInputError } from "./pdf.ts";
import { parseScriptText } from "./pipeline.ts";
import { extractSource, type SourceKind } from "./source.ts";
import type { LabelProgress } from "./pipeline.ts";
import type { StructuredScript } from "./types.ts";

export type ScriptSource = { kind: Exclude<SourceKind, "text">; data: Buffer } | { kind: "text"; text: string; data?: Buffer };

const EXTENSIONS: Record<SourceKind, [string, string]> = {
  pdf: ["pdf", "application/pdf"],
  docx: ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  text: ["txt", "text/plain; charset=utf-8"],
};

// Stores the raw upload, marks the production as parsing and runs the parse in the background.
export async function startScriptParse(ctx: Ctx, productionId: string, source: ScriptSource): Promise<string> {
  const scriptId = randomUUID();
  const [ext, contentType] = EXTENSIONS[source.kind];
  const key = `productions/${productionId}/scripts/${scriptId}.${ext}`;
  const bytes = source.kind === "text" ? (source.data ?? Buffer.from(source.text, "utf8")) : source.data;
  await ctx.storage.put(key, bytes, contentType);
  if (await sweepIfDeleted(ctx, productionId)) throw new ContentDeletedError();
  await ctx.sql.begin(async (tx) => {
    // The row lock orders this with deleteProductionContent's transaction: a script inserted first
    // is deleted with the rest; one that comes second sees the production is gone.
    const [p] = await tx<{ contentDeletedAt: Date | null }[]>`select content_deleted_at from productions where id = ${productionId} for update`;
    if (p?.contentDeletedAt) throw new ContentDeletedError();
    await tx`insert into scripts (id, production_id, source_kind, storage_key, raw_text)
             values (${scriptId}, ${productionId}, ${source.kind}, ${key}, ${source.kind === "text" ? source.text : null})`;
    await tx`update productions set script_status = 'parsing', script_error = null where id = ${productionId}`;
  });
  ctx.jobs.run(`parse ${scriptId}`, () => runScriptParse(ctx, scriptId));
  return scriptId;
}

// Idempotent: re-running a script replaces the production's parsed lines with a fresh parse.
export async function runScriptParse(ctx: Ctx, scriptId: string): Promise<void> {
  const [script] = await ctx.sql<{ id: string; productionId: string; sourceKind: string; storageKey: string; rawText: string | null }[]>`
    select id, production_id, source_kind, storage_key, raw_text from scripts where id = ${scriptId}`;
  if (!script) return;
  const started = Date.now();
  const progress = progressWriter(ctx, scriptId);
  try {
    await progress.set({ stage: "reading" }, true);
    let text = script.rawText;
    if (text === null) {
      const source = await extractSource(await ctx.storage.get(script.storageKey), script.sourceKind as SourceKind);
      text = source.text;
      await ctx.sql`update scripts set raw_text = ${text} where id = ${scriptId}`;
      await progress.set({ pages: source.pages }, true);
    }
    const { structure, usage } = await parseScriptText(text, {
      labeler: ctx.labeler,
      log: ctx.log,
      onProgress: (p) => void progress.set({ stage: "labelling", ...p }),
    });
    await progress.set({ stage: "saving" }, true);
    ctx.log.info({ scriptId, productionId: script.productionId, ms: Date.now() - started, lines: structure.lines.length, ...usage }, "script parsed");
    const current = await ctx.sql.begin(async (tx) => {
      const [latest] = await tx`select id from scripts where production_id = ${script.productionId} order by created_at desc limit 1 for update`;
      if (latest?.id !== scriptId) return false;
      await saveStructure(tx, script.productionId, structure);
      await tx`select sync_shared_lines(${script.productionId})`;
      await tx`update scripts set status = 'ready', parser = ${usage.parser}, usage = ${JSON.stringify(usage)}::jsonb, completed_at = now() where id = ${scriptId}`;
      await tx`update productions set script_status = 'ready', script_error = null where id = ${script.productionId}`;
      return true;
    });
    if (current) inferInBackground(ctx, script.productionId);
    if (!current) await ctx.sql`update scripts set status = 'failed', error = 'Replaced by a newer upload', completed_at = now() where id = ${scriptId}`;
  } catch (err) {
    const message = err instanceof ScriptInputError ? err.message : "Something went wrong while reading the script. Try again.";
    if (!(err instanceof ScriptInputError)) ctx.log.error({ err, scriptId }, "script parse failed");
    await ctx.sql`update scripts set status = 'failed', error = ${message}, completed_at = now() where id = ${scriptId}`;
    await ctx.sql`update productions set script_status = 'failed', script_error = ${message}
                  where id = ${script.productionId}
                    and ${scriptId} = (select id from scripts where production_id = ${script.productionId} order by created_at desc limit 1)`;
  }
}

export type ParseProgress = Partial<LabelProgress> & { stage?: "reading" | "labelling" | "saving"; pages?: number | null };

// Saves parse progress for the director's progress bar: at most about once a second, since chunks
// finish in bursts, and always when forced (stage changes).
function progressWriter(ctx: Ctx, scriptId: string) {
  let state: ParseProgress = {};
  let lastWrite = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const write = () => {
    if (trailing) clearTimeout(trailing);
    trailing = null;
    lastWrite = Date.now();
    const snapshot = JSON.stringify(state);
    pending = pending
      .then(() => ctx.sql`update scripts set progress = ${snapshot}::jsonb where id = ${scriptId}`)
      .catch((err: unknown) => ctx.log.warn({ err: String(err), scriptId }, "could not save parse progress"));
    return pending;
  };
  return {
    set(update: ParseProgress, force = false): Promise<unknown> {
      state = { ...state, ...update };
      const wait = 700 - (Date.now() - lastWrite);
      if (force || wait <= 0) return write();
      // Within the throttle window: save the latest state once the window ends.
      trailing ??= setTimeout(() => void write(), wait);
      return pending;
    },
  };
}

// Replaces sections, characters and lines. Cast assignments are carried over by character name.
async function saveStructure(tx: Tx, productionId: string, s: StructuredScript): Promise<void> {
  const [recorded] = await tx`select 1 from takes where production_id = ${productionId} limit 1`;
  if (recorded) throw new ScriptInputError("Recordings already exist for this script, so it can't be replaced.");
  const cast = await tx<{ actorId: string; name: string }[]>`
    select ac.actor_id, lower(c.name) as name from actor_characters ac join characters c on c.id = ac.character_id where c.production_id = ${productionId}`;
  await tx`delete from actor_characters where character_id in (select id from characters where production_id = ${productionId})`;
  await tx`delete from lines where production_id = ${productionId}`;
  await tx`delete from sections where production_id = ${productionId}`;
  await tx`delete from characters where production_id = ${productionId}`;

  const sectionIds = s.sections.map(() => randomUUID());
  const characterIds = new Map(s.characters.map((c) => [c.name, randomUUID()]));
  await tx`insert into sections ${tx(s.sections.map((sec, i) => ({ id: sectionIds[i]!, productionId, seq: i + 1, act: sec.act, scene: sec.scene, title: sec.title })))}`;
  if (s.characters.length) {
    await tx`insert into characters ${tx(s.characters.map((c) => ({ id: characterIds.get(c.name)!, productionId, name: c.name, aliases: c.aliases })))}`;
  }
  const rows = s.lines.map((l, i) => ({
    productionId,
    sectionId: sectionIds[l.section]!,
    seq: i + 1,
    kind: l.kind,
    characterId: l.character ? characterIds.get(l.character)! : null,
    text: l.text,
    // No script review: the parser's flags are not stored, the parse is taken as read.
    flagged: false,
    flagCode: null,
    flagReason: null,
    sourceLine: l.sourceLine,
    sourcePage: l.page,
  }));
  for (let i = 0; i < rows.length; i += 1000) await tx`insert into lines ${tx(rows.slice(i, i + 1000))}`;

  for (const { actorId, name } of cast) {
    const match = s.characters.find((c) => c.name.toLowerCase() === name || c.aliases.some((a) => a.toLowerCase() === name));
    if (match) await tx`insert into actor_characters (actor_id, character_id) values (${actorId}, ${characterIds.get(match.name)!}) on conflict do nothing`;
  }
}

// Parses interrupted by a restart are re-run from their stored text.
export async function recoverScriptParses(ctx: Ctx): Promise<void> {
  const stuck = await ctx.sql<{ id: string }[]>`select id from scripts where status = 'parsing' order by created_at`;
  for (const { id } of stuck) ctx.jobs.run(`parse ${id}`, () => runScriptParse(ctx, id));
}
