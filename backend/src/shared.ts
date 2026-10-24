import Anthropic from "@anthropic-ai/sdk";
import type { Ctx } from "./context.ts";
import type { Sql } from "./db.ts";
import { PARSE_MODEL } from "./parse/label.ts";
import { checkCastComplete } from "./render/queue.ts";

// Shared lines: lines several characters say together. sync_shared_lines (migration 011) works out
// groups from character names and gives each shared line its voices: a named group's members, or,
// for ALL and the like, everyone who speaks in the scene. Claude Haiku then reads each scene with an
// ALL line and narrows it to who is on stage at that moment.

export const syncShared = async (sql: Sql, productionId: string) => {
  await sql`select sync_shared_lines(${productionId})`;
};

export interface EnsembleRequest {
  characters: string[]; // every speaking character, by name (no groups)
  scene: string[]; // the scene, one numbered row per line: "SPEAKER: text" or "(direction)"
  targets: number[]; // 1-based rows said by a group, to answer for
  labels: Record<number, string>; // the group's name on each target row ("ALL", "BOTH")
}

// Who says each target row, by character name. Rows left out keep the whole-scene guess.
export type EnsembleInferrer = (req: EnsembleRequest) => Promise<Record<number, string[]>>;

const SYSTEM = `You read play scripts. Some speeches are said by several characters at once and are labelled with a group name such as ALL, BOTH, EVERYONE or OMNES instead of one speaker.
For each target row, decide which characters say that speech together: the characters on stage at that moment who would join in. Use entrances, exits, stage directions, who has been speaking and who is being addressed. A character who has exited, or has not entered yet, does not speak. BOTH means exactly two characters.
Use only names from the character list, spelled exactly as listed.
Reply with JSON only, no prose: an object mapping each target row number to a list of names, for example {"14": ["ANNA", "BEN"]}.`;

const MAX_ROW_CHARS = 400;

export function buildEnsemblePrompt(req: EnsembleRequest): string {
  return [
    `Characters: ${req.characters.join(", ")}`,
    `Scene:\n${req.scene.map((row, i) => `${i + 1}| ${row.length > MAX_ROW_CHARS ? `${row.slice(0, MAX_ROW_CHARS)}…` : row}`).join("\n")}`,
    `Target rows: ${req.targets.map((n) => `${n} (${req.labels[n] ?? "ALL"})`).join(", ")}`,
  ].join("\n\n");
}

// Pulls the JSON object out of the reply; anything unreadable counts as no answer.
export function parseEnsembleReply(text: string): Record<number, string[]> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const out: Record<number, string[]> = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(k);
      if (Number.isInteger(n) && Array.isArray(v)) out[n] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

export function createClaudeEnsembleInferrer(apiKey: string): EnsembleInferrer {
  const client = new Anthropic({ apiKey, maxRetries: 4, timeout: 120_000 });
  return async (req) => {
    const message = await client.messages.create({
      model: PARSE_MODEL,
      max_tokens: 2000,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: buildEnsemblePrompt(req) }],
    });
    return parseEnsembleReply(message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
  };
}

// One pass per production at a time, and once per process for lines the model couldn't answer, so a
// failing call is never retried in a loop.
const running = new Map<string, Promise<void>>();
const asked = new Set<string>();

// After any change to a production's characters or lines: recompute shared lines, then ask Claude
// in the background about ALL lines that only have the whole-scene guess.
export async function afterCastChange(ctx: Ctx, productionId: string): Promise<void> {
  await syncShared(ctx.sql, productionId);
  inferInBackground(ctx, productionId);
  // A line deleted or joined, or a duplicate part merged, can leave every picked part recorded.
  checkCastComplete(ctx, productionId);
}

export function inferInBackground(ctx: Ctx, productionId: string): void {
  if (!ctx.ensemble || running.has(productionId)) return;
  const job = inferEnsembleVoices(ctx, productionId)
    .then(() => undefined)
    .finally(() => running.delete(productionId));
  running.set(productionId, job);
  ctx.jobs.run("infer shared line voices", () => job);
}

interface SceneRow {
  id: string;
  sectionId: string;
  kind: "dialogue" | "stage_direction" | "heading";
  name: string | null;
  everyone: boolean;
  voicesSource: string | null;
  text: string;
}

export async function inferEnsembleVoices(ctx: Ctx, productionId: string): Promise<number> {
  const infer = ctx.ensemble;
  if (!infer) return 0;
  const { sql } = ctx;
  const pending = await sql<{ sectionId: string }[]>`
    select distinct section_id from lines where production_id = ${productionId} and voices_source = 'scene'`;
  const sections = pending.map((p) => p.sectionId).filter((id) => !asked.has(`${productionId}:${id}`));
  if (!sections.length) return 0;
  const characters = await sql<{ id: string; name: string; aliases: string[] }[]>`
    select id, name, aliases from characters where production_id = ${productionId} and not is_group order by lower(name)`;
  const byName = new Map<string, string>();
  for (const c of characters) for (const n of [c.name, ...c.aliases]) if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), c.id);
  let updated = 0;
  for (const sectionId of sections) {
    asked.add(`${productionId}:${sectionId}`);
    const rows = await sql<SceneRow[]>`
      select l.id, l.section_id, l.kind, c.name, coalesce(c.everyone, false) as everyone, l.voices_source, l.text
      from lines l left join characters c on c.id = l.character_id
      where l.section_id = ${sectionId} order by l.seq`;
    const targets = rows.flatMap((r, i) => (r.voicesSource === "scene" ? [i + 1] : []));
    if (!targets.length) continue;
    const labels = Object.fromEntries(targets.map((n) => [n, rows[n - 1]!.name ?? "ALL"]));
    const scene = rows.map((r) => (r.kind === "dialogue" ? `${r.name ?? "?"}: ${r.text}` : r.kind === "heading" ? `== ${r.text}` : `(${r.text})`));
    let answer: Record<number, string[]>;
    try {
      answer = await infer({ characters: characters.map((c) => c.name), scene, targets, labels });
    } catch (err) {
      ctx.log.warn({ err, productionId, sectionId }, "shared line inference failed; keeping the whole scene");
      continue;
    }
    for (const n of targets) {
      const ids = [...new Set((answer[n] ?? []).flatMap((name) => byName.get(name.trim().toLowerCase()) ?? []))];
      if (!ids.length) continue;
      // Only lines still on the whole-scene guess: a director's pick made meanwhile wins.
      const done = await sql`
        update lines set voice_ids = ${ids}::uuid[], voices_source = 'model', updated_at = now()
        where id = ${rows[n - 1]!.id} and voices_source = 'scene' returning id`;
      updated += done.length;
    }
  }
  if (updated) ctx.log.info({ productionId, lines: updated }, "shared line voices inferred");
  return updated;
}
