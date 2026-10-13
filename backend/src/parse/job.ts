import { randomUUID } from "node:crypto";
import type { Ctx } from "../context.ts";
import type { Tx } from "../db.ts";
import { extractPdfText, ScriptInputError } from "./pdf.ts";
import { parseScriptText } from "./pipeline.ts";
import type { StructuredScript } from "./types.ts";

export type ScriptSource = { kind: "pdf"; data: Buffer } | { kind: "text"; text: string };

// Stores the raw upload, marks the production as parsing and runs the parse in the background.
export async function startScriptParse(ctx: Ctx, productionId: string, source: ScriptSource): Promise<string> {
  const scriptId = randomUUID();
  const key = `productions/${productionId}/scripts/${scriptId}.${source.kind === "pdf" ? "pdf" : "txt"}`;
  if (source.kind === "pdf") await ctx.storage.put(key, source.data, "application/pdf");
  else await ctx.storage.put(key, Buffer.from(source.text, "utf8"), "text/plain; charset=utf-8");
  await ctx.sql.begin(async (tx) => {
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
  try {
    let text = script.rawText;
    if (text === null) {
      const pdf = await extractPdfText(new Uint8Array(await ctx.storage.get(script.storageKey)));
      text = pdf.text;
      await ctx.sql`update scripts set raw_text = ${text} where id = ${scriptId}`;
    }
    const { structure, usage } = await parseScriptText(text, { chunkParser: ctx.chunkParser, log: ctx.log });
    ctx.log.info({ scriptId, productionId: script.productionId, ms: Date.now() - started, lines: structure.lines.length, ...usage }, "script parsed");
    const current = await ctx.sql.begin(async (tx) => {
      const [latest] = await tx`select id from scripts where production_id = ${script.productionId} order by created_at desc limit 1 for update`;
      if (latest?.id !== scriptId) return false;
      await saveStructure(tx, script.productionId, structure);
      await tx`update scripts set status = 'ready', parser = ${usage.parser}, usage = ${JSON.stringify(usage)}::jsonb, completed_at = now() where id = ${scriptId}`;
      await tx`update productions set script_status = 'ready', script_error = null where id = ${script.productionId}`;
      return true;
    });
    if (!current) await ctx.sql`update scripts set status = 'failed', error = 'Replaced by a newer upload', completed_at = now() where id = ${scriptId}`;
  } catch (err) {
    const message = err instanceof ScriptInputError ? err.message : "Something went wrong while reading the script. Try again, or paste the text instead.";
    if (!(err instanceof ScriptInputError)) ctx.log.error({ err, scriptId }, "script parse failed");
    await ctx.sql`update scripts set status = 'failed', error = ${message}, completed_at = now() where id = ${scriptId}`;
    await ctx.sql`update productions set script_status = 'failed', script_error = ${message}
                  where id = ${script.productionId}
                    and ${scriptId} = (select id from scripts where production_id = ${script.productionId} order by created_at desc limit 1)`;
  }
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
    flagged: l.flagReason !== null,
    flagReason: l.flagReason,
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
