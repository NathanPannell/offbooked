import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import type { Sql } from "../db.ts";
import { notifyCastComplete } from "../email/notify.ts";
import { concatToM4a, makeSilence, normalizeTake } from "./ffmpeg.ts";
import type { TtsRequest } from "../tts/service.ts";
import { contentHash, planRender, RENDER_SETTINGS, type PlanLine, type TimingEntry } from "./plan.ts";

const MAX_DEBOUNCE_MS = 120_000;

export interface RenderInput extends PlanLine {
  characterId: string;
  cast: boolean; // the character has an actor
  actorRecorded: boolean; // the cast actor has recorded this line (stand-ins don't count)
}

// Dialogue lines in order with their current takes (the newest take, by the actor or a stand-in).
export async function renderInputs(sql: Sql, productionId: string): Promise<RenderInput[]> {
  return sql<RenderInput[]>`
    select l.id as line_id, l.section_id, l.text, l.character_id, l.current_take_id as take_id, t.recorded_by as take_source,
      exists (select 1 from actor_characters ac where ac.character_id = l.character_id) as cast,
      exists (select 1 from takes a where a.line_id = l.id and a.recorded_by = 'actor') as actor_recorded
    from lines l left join takes t on t.id = l.current_take_id
    where l.production_id = ${productionId} and l.kind = 'dialogue'
    order by l.seq`;
}

// Render inputs plus a TTS clip for every line without a take, when TTS can run here. The clip
// hashes are part of the content hash, so a changed line or voice makes the render stale.
export async function planInputs(ctx: Ctx, productionId: string): Promise<{ lines: RenderInput[]; requests: TtsRequest[] }> {
  const lines = await renderInputs(ctx.sql, productionId);
  const requests: TtsRequest[] = [];
  const engine = ctx.tts ? await ctx.tts.engine() : null;
  if (ctx.tts && engine && lines.some((l) => !l.takeId)) {
    const voices = await ctx.tts.voices(productionId);
    for (const l of lines) {
      if (l.takeId) continue;
      const r = ctx.tts.request(engine, voices.get(l.characterId), l.text);
      if (!r) continue;
      l.ttsHash = r.hash;
      requests.push(r);
    }
  }
  return { lines, requests };
}

// Debounced: each new take pushes the queued job back, up to two minutes after it was first queued.
export async function scheduleRender(ctx: Ctx, productionId: string, opts: { force?: boolean } = {}): Promise<void> {
  const delay = opts.force ? 0 : ctx.config.renderDebounceMs;
  await ctx.sql`
    insert into renders (production_id, status, forced, run_after)
    values (${productionId}, 'queued', ${Boolean(opts.force)}, now() + ${delay} * interval '1 millisecond')
    on conflict (production_id) where status = 'queued' do update set
      forced = renders.forced or excluded.forced,
      run_after = case when excluded.forced then now()
                       else least(excluded.run_after, renders.created_at + ${MAX_DEBOUNCE_MS} * interval '1 millisecond') end`;
}

async function claimNext(sql: Sql): Promise<{ id: string; productionId: string; forced: boolean } | undefined> {
  const [row] = await sql<{ id: string; productionId: string; forced: boolean }[]>`
    update renders set status = 'rendering', started_at = now()
    where id = (
      select r.id from renders r
      where r.status = 'queued' and r.run_after <= now()
        and not exists (select 1 from renders x where x.production_id = r.production_id and x.status = 'rendering')
      order by r.run_after limit 1 for update skip locked)
    returning id, production_id, forced`;
  return row;
}

export async function processDueRenders(ctx: Ctx): Promise<number> {
  let count = 0;
  for (let job = await claimNext(ctx.sql); job; job = await claimNext(ctx.sql)) {
    await runRender(ctx, job);
    count++;
  }
  return count;
}

export function startRenderWorker(ctx: Ctx, intervalMs = 2000): { stop: () => Promise<void>; kick: () => void } {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = processDueRenders(ctx)
      .then(() => undefined)
      .catch((err) => ctx.log.error({ err }, "render worker failed"))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    kick: tick,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}

// After a restart nothing is really rendering; requeue those jobs (or fail them if one is already queued).
export async function recoverRenders(ctx: Ctx): Promise<void> {
  await ctx.sql`
    update renders r set status = 'queued', run_after = now(), started_at = null
    where r.status = 'rendering' and not exists (select 1 from renders q where q.production_id = r.production_id and q.status = 'queued')`;
  await ctx.sql`update renders set status = 'failed', error = 'Interrupted by a restart', finished_at = now() where status = 'rendering'`;
}

async function runRender(ctx: Ctx, job: { id: string; productionId: string; forced: boolean }): Promise<void> {
  const { sql, storage, log } = ctx;
  const started = Date.now();
  const workDir = await mkdtemp(path.join(tmpdir(), "offbooked-render-"));
  try {
    const { lines, requests } = await planInputs(ctx, job.productionId);
    const hash = contentHash(lines);
    // Completion counts only the cast actors' own takes, never stand-ins or TTS.
    const allCastRecorded = lines.some((l) => l.cast) && lines.every((l) => !l.cast || l.actorRecorded);

    const [cached] = job.forced
      ? []
      : await sql<{ storageKey: string; durationMs: number; timing: TimingEntry[]; takeIds: string[] }[]>`
          select storage_key, duration_ms, timing, take_ids from renders
          where production_id = ${job.productionId} and status = 'ready' and content_hash = ${hash}
          order by created_at desc limit 1`;
    if (cached) {
      await sql`update renders set status = 'ready', content_hash = ${hash}, storage_key = ${cached.storageKey}, duration_ms = ${cached.durationMs},
                timing = ${sql.json(cached.timing as never)}, take_ids = ${cached.takeIds}, all_recorded = ${allCastRecorded}, finished_at = now()
                where id = ${job.id}`;
    } else {
      // Takes normalize while TTS synthesizes on its own worker pool.
      const [takeSamples, ttsSamples] = await Promise.all([
        prepareTakes(ctx, job.productionId, lines.flatMap((l) => (l.takeId ? [l.takeId] : [])), workDir),
        prepareTts(ctx, requests, workDir).then((samples) => {
          if (requests.length) log.info({ renderId: job.id, lines: requests.length, ready: samples.size, ms: Date.now() - started }, "render tts ready");
          return samples;
        }),
      ]);
      const plan = planRender(lines, takeSamples, ttsSamples);
      const files: string[] = [];
      // Gaps between lines come in a few lengths; make each length once.
      const silences = new Set<number>();
      for (const seg of plan.segments) {
        if (seg.kind === "take") files.push(path.join(workDir, `take-${seg.takeId}.flac`));
        else if (seg.kind === "tts") files.push(path.join(workDir, `tts-${seg.hash}.flac`));
        else {
          const file = path.join(workDir, `silence-${seg.samples}.flac`);
          if (!silences.has(seg.samples)) await makeSilence(seg.samples, file);
          silences.add(seg.samples);
          files.push(file);
        }
      }
      if (!files.length) throw new Error("There are no dialogue lines to render");
      const out = path.join(workDir, "render.m4a");
      await concatToM4a(files, workDir, out);
      const key = `productions/${job.productionId}/renders/${job.id}.m4a`;
      await storage.put(key, await readFile(out), "audio/mp4");
      const takeIds = [...takeSamples.keys()];
      await sql`update renders set status = 'ready', content_hash = ${hash}, storage_key = ${key},
                duration_ms = ${Math.round((plan.totalSamples * 1000) / RENDER_SETTINGS.sampleRate)}, timing = ${sql.json(plan.timing as never)},
                take_ids = ${takeIds}, all_recorded = ${allCastRecorded}, finished_at = now()
                where id = ${job.id}`;
    }
    log.info({ renderId: job.id, productionId: job.productionId, ms: Date.now() - started, lines: lines.length, cached: Boolean(cached) }, "render ready");
    if (allCastRecorded) await notifyCastComplete(ctx, job.productionId);
  } catch (err) {
    log.error({ err, renderId: job.id }, "render failed");
    await sql`update renders set status = 'failed', error = ${String((err as Error).message).slice(0, 500)}, finished_at = now() where id = ${job.id}`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Synthesizes (or reuses) a clip for each line without a take and downloads them. Lines whose
// clip failed are left out and render as silence. Returns measured lengths in samples by hash.
async function prepareTts(ctx: Ctx, requests: TtsRequest[], workDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!ctx.tts || !requests.length) return result;
  const clips = [...(await ctx.tts.ensure(requests)).values()];
  await eachLimit(clips, 8, async (clip) => {
    try {
      await writeFile(path.join(workDir, `tts-${clip.hash}.flac`), await ctx.storage.get(clip.storageKey));
      result.set(clip.hash, clip.samples);
    } catch (err) {
      ctx.log.warn({ err, key: clip.storageKey }, "tts clip missing from storage; rendering silence");
    }
  });
  return result;
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Downloads each take's normalized audio, normalizing (and caching in storage) any take seen for
// the first time. Returns measured lengths in samples.
async function prepareTakes(ctx: Ctx, productionId: string, takeIds: string[], workDir: string): Promise<Map<string, number>> {
  const { sql, storage } = ctx;
  const result = new Map<string, number>();
  if (!takeIds.length) return result;
  const takes = await sql<{ id: string; storageKey: string; normalizedKey: string | null; normalizedSamples: number | null }[]>`
    select id, storage_key, normalized_key, normalized_samples from takes where id = any(${takeIds}::uuid[])`;
  for (const take of takes) {
    const file = path.join(workDir, `take-${take.id}.flac`);
    if (take.normalizedKey && take.normalizedSamples && (await storage.exists(take.normalizedKey))) {
      await writeFile(file, await storage.get(take.normalizedKey));
      result.set(take.id, take.normalizedSamples);
      continue;
    }
    const source = path.join(workDir, `source-${take.id}${path.extname(take.storageKey)}`);
    await writeFile(source, await storage.get(take.storageKey));
    const samples = await normalizeTake(source, file);
    const key = `productions/${productionId}/normalized/${take.id}.flac`;
    await storage.put(key, await readFile(file), "audio/flac");
    await sql`update takes set normalized_key = ${key}, normalized_samples = ${samples} where id = ${take.id}`;
    result.set(take.id, samples);
  }
  return result;
}
