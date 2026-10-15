import type { Ctx } from "./context.ts";
import type { AudioSource } from "./render/plan.ts";
import { TTS_PRIORITY } from "./tts/service.ts";
import { takeColumns, type LineRow, type TakeRow } from "./views.ts";

export interface CueView {
  characterName: string;
  text: string;
  audioUrl: string | null;
  audioSource: AudioSource;
}

// Cue audio is the cue line's current take (actor or stand-in) when there is one, else a TTS clip.
// Missing clips are synthesized in the background; the response waits up to waitMs for them and
// returns the rest as { audioUrl: null, audioSource: "none" }, so a later fetch picks them up and
// the app can fall back to on-device speech meanwhile.
export async function cueViews(ctx: Ctx, productionId: string, cues: (LineRow | null)[], opts: { waitMs?: number } = {}): Promise<(CueView | null)[]> {
  const { sql, storage } = ctx;
  const present = cues.filter((c): c is LineRow => c !== null);
  if (!present.length) return cues.map(() => null);
  const names = new Map(
    (await sql<{ id: string; name: string }[]>`select id, name from characters where production_id = ${productionId}`).map((c) => [c.id, c.name]),
  );
  const takeIds = [...new Set(present.flatMap((c) => (c.currentTakeId ? [c.currentTakeId] : [])))];
  const takes = new Map(
    (takeIds.length ? await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = any(${takeIds}::uuid[])` : []).map((t) => [t.id, t]),
  );

  const ttsUrls = await ttsCueUrls(ctx, productionId, present.filter((c) => !c.currentTakeId), opts.waitMs ?? ctx.config.tts.cueWaitMs);
  return Promise.all(
    cues.map(async (cue) => {
      if (!cue) return null;
      const base = { characterName: names.get(cue.characterId!) ?? "", text: cue.text };
      const take = cue.currentTakeId ? takes.get(cue.currentTakeId) : undefined;
      if (take) return { ...base, audioUrl: await storage.signedUrl(take.storageKey), audioSource: take.recordedBy };
      const url = ttsUrls.get(cue.id);
      return url ? { ...base, audioUrl: url, audioSource: "tts" as const } : { ...base, audioUrl: null, audioSource: "none" as const };
    }),
  );
}

// Signed .m4a URLs by line id for TTS cue clips that are ready (or become ready within waitMs).
async function ttsCueUrls(ctx: Ctx, productionId: string, lines: LineRow[], waitMs: number): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const tts = ctx.tts;
  const engine = tts && lines.length ? await tts.engine() : null;
  if (!tts || !engine) return urls;
  const voices = await tts.voices(productionId);
  const byLine = new Map(lines.flatMap((l) => {
    const r = tts.request(engine, voices.get(l.characterId ?? ""), l.text);
    return r ? [[l.id, r] as const] : [];
  }));
  const requests = [...byLine.values()];
  let clips = await tts.cached(requests.map((r) => r.hash));
  const missing = requests.filter((r) => !clips.get(r.hash)?.cueKey);
  if (missing.length) {
    // An actor waiting on the lines page outranks a warm-up started when they opened their link.
    const pending = tts.ensure(missing, { cue: true, priority: waitMs > 0 ? TTS_PRIORITY.prefetch : TTS_PRIORITY.cue });
    ctx.jobs.run("tts cue warm-up", () => pending.then(() => undefined));
    if (waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([pending, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
      clips = await tts.cached(requests.map((r) => r.hash));
    }
  }
  for (const [lineId, r] of byLine) {
    const key = clips.get(r.hash)?.cueKey;
    if (key) urls.set(lineId, await ctx.storage.signedUrl(key));
  }
  return urls;
}

// Starts synthesizing cue clips without waiting, e.g. when an actor opens their link.
export async function warmCues(ctx: Ctx, productionId: string, cues: LineRow[]): Promise<void> {
  await ttsCueUrls(ctx, productionId, cues.filter((c) => !c.currentTakeId), 0);
}

// The cue for each line: the closest earlier dialogue line by a character that isn't speaking it.
// `isOwn` says which characters count as "the same speaker" (an actor's characters, or the line's).
export function previousCue(lines: LineRow[], index: number, isOwn: (characterId: string) => boolean): LineRow | null {
  for (let j = index - 1; j >= 0; j--) {
    const prev = lines[j]!;
    if (prev.kind === "dialogue" && !isOwn(prev.characterId!)) return prev;
  }
  return null;
}
