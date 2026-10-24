import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import type { Sql } from "../db.ts";
import { notifyCastComplete } from "../email/notify.ts";
import { concatToM4a, makeSilence } from "./ffmpeg.ts";
import { mixedClip, mixHash, voiceTakes } from "./mix.ts";
import { normalizedTake, type TakeAudioRow } from "./takeaudio.ts";
import { ContentDeletedError, sweepIfDeleted } from "../retention.ts";
import { TTS_PRIORITY, type TtsRequest } from "../tts/service.ts";
import { contentHash, planRender, RENDER_SETTINGS, type PlanLine, type TimingEntry } from "./plan.ts";

const MAX_DEBOUNCE_MS = 120_000;

export interface RenderInput extends PlanLine {
  characterId: string;
  cast: boolean; // someone in the cast picked one of the line's voices
  castRecorded: boolean; // every picked voice has a take (by anyone: the cast or the director)
  mixTakeIds?: string[]; // a shared line voiced by several takes: takeId is then "mix-<hash>"
}

// Dialogue lines in order with their current takes (the newest take, by anyone).
// A shared line uses its voices' takes: one plays as it is, several are mixed (mix.ts).
export async function renderInputs(sql: Sql, productionId: string): Promise<RenderInput[]> {
  const lines = await sql<(RenderInput & { shared: boolean })[]>`
    select l.id as line_id, l.section_id, l.text, l.character_id, l.current_take_id as take_id, t.recorded_by as take_source,
      l.voice_ids is not null as shared,
      exists (select 1 from line_voices lv join actor_characters ac on ac.character_id = lv.character_id where lv.line_id = l.id) as cast,
      not exists (select 1 from line_voices lv where lv.line_id = l.id
                    and exists (select 1 from actor_characters ac where ac.character_id = lv.character_id)
                    and voice_take(lv.line_id, lv.shared, lv.character_id) is null) as cast_recorded
    from lines l left join takes t on t.id = l.current_take_id
    where l.production_id = ${productionId} and l.kind = 'dialogue'
    order by l.seq`;
  if (!lines.some((l) => l.shared)) return lines;
  const byVoice = await voiceTakes(sql, productionId);
  for (const l of lines) {
    const takes = byVoice.get(l.lineId);
    if (!takes?.length) continue;
    l.takeSource = takes.some((t) => t.recordedBy === "actor") ? "actor" : "director";
    if (takes.length === 1) l.takeId = takes[0]!.id;
    else {
      l.mixTakeIds = takes.map((t) => t.id);
      l.takeId = `mix-${mixHash(l.mixTakeIds)}`;
    }
  }
  return lines;
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
// Wakes the worker so it can sleep until the job is due.
export async function scheduleRender(ctx: Ctx, productionId: string, opts: { force?: boolean } = {}): Promise<void> {
  const delay = opts.force ? 0 : ctx.config.renderDebounceMs;
  await ctx.sql`
    insert into renders (production_id, status, forced, run_after)
    values (${productionId}, 'queued', ${Boolean(opts.force)}, now() + ${delay} * interval '1 millisecond')
    on conflict (production_id) where status = 'queued' do update set
      forced = renders.forced or excluded.forced,
      run_after = case when excluded.forced then now()
                       else least(excluded.run_after, renders.created_at + ${MAX_DEBOUNCE_MS} * interval '1 millisecond') end`;
  ctx.renderWorker.kick();
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

// Milliseconds until the next claimable queued job is due, or null when nothing is queued.
// Productions with a render in progress are skipped, as in claimNext.
export async function nextRenderDueMs(sql: Sql): Promise<number | null> {
  const [row] = await sql<{ ms: number | null }[]>`
    select ceil(extract(epoch from min(r.run_after) - now()) * 1000)::float8 as ms from renders r
    where r.status = 'queued'
      and not exists (select 1 from renders x where x.production_id = r.production_id and x.status = 'rendering')`;
  return row?.ms ?? null;
}

const RETRY_MS = 60_000;
const MAX_SLEEP_MS = 2 ** 31 - 1;

// Event driven, never polled: an idle server sends no queries, so Neon can scale the database to
// zero. A pass runs at startup and on every kick (scheduleRender kicks), then the worker sleeps
// until the next queued job is due.
export function startRenderWorker(ctx: Ctx): { stop: () => Promise<void>; kick: () => void } {
  let running: Promise<void> | null = null;
  let kicked = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = (ms: number | null) => {
    clearTimeout(timer);
    if (ms === null || stopped) return;
    timer = setTimeout(tick, Math.min(Math.max(ms, 50), MAX_SLEEP_MS));
    timer.unref();
  };
  const pass = async () => {
    await processDueRenders(ctx);
    sleep(await nextRenderDueMs(ctx.sql));
  };
  const tick = () => {
    if (stopped) return;
    // A kick during a pass may have queued a job the pass already looked past; run again after it.
    if (running) {
      kicked = true;
      return;
    }
    clearTimeout(timer);
    running = pass()
      .catch((err) => {
        ctx.log.error({ err }, "render worker failed");
        sleep(RETRY_MS);
      })
      .finally(() => {
        running = null;
        if (kicked) {
          kicked = false;
          tick();
        }
      });
  };
  tick();
  return {
    kick: tick,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
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
    // The cast is complete once every part someone picked is recorded (by anyone; TTS never counts).
    const allCastRecorded = lines.some((l) => l.cast) && lines.every((l) => !l.cast || l.castRecorded);

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
        prepareTakes(
          ctx,
          job.productionId,
          lines.flatMap((l) => (l.takeId && !l.mixTakeIds ? [l.takeId] : [])),
          workDir,
        ).then(async (samples) => {
          for (const [key, value] of await prepareMixes(ctx, job.productionId, lines, workDir)) samples.set(key, value);
          return samples;
        }),
        prepareTts(ctx, requests, workDir, job.productionId).then((samples) => {
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
      if (await sweepIfDeleted(ctx, job.productionId)) throw new ContentDeletedError();
      const takeIds = [...new Set(lines.flatMap((l) => l.mixTakeIds ?? (l.takeId && takeSamples.has(l.takeId) ? [l.takeId] : [])))];
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
async function prepareTts(ctx: Ctx, requests: TtsRequest[], workDir: string, productionId: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!ctx.tts || !requests.length) return result;
  const clips = [...(await ctx.tts.ensure(requests, { priority: TTS_PRIORITY.render, productionId })).values()];
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

// Shared lines with several takes: each mix, made (and cached) on first use, written to the work
// directory as take-<takeId>.flac like a take. Returns measured lengths in samples by takeId.
async function prepareMixes(ctx: Ctx, productionId: string, lines: RenderInput[], workDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const mixed = lines.filter((l) => l.mixTakeIds && l.takeId);
  if (!mixed.length) return result;
  const ids = [...new Set(mixed.flatMap((l) => l.mixTakeIds!))];
  const takes = new Map(
    (await ctx.sql<TakeAudioRow[]>`select id, storage_key, normalized_key, normalized_samples, stream_key from takes where id = any(${ids}::uuid[])`).map(
      (t) => [t.id, t],
    ),
  );
  for (const l of mixed) {
    if (result.has(l.takeId!)) continue;
    try {
      const clip = await mixedClip(
        ctx,
        productionId,
        l.mixTakeIds!.flatMap((id) => (takes.has(id) ? [takes.get(id)!] : [])),
        {
          flacTo: path.join(workDir, `take-${l.takeId}.flac`),
        },
      );
      result.set(l.takeId!, clip.samples);
    } catch (err) {
      ctx.log.warn({ err, lineId: l.lineId }, "mixing a shared line failed; rendering silence");
    }
  }
  return result;
}

// Downloads each take's normalized audio, normalizing (and caching in storage) any take seen for
// the first time. Line-by-line playback shares the cache (see takeaudio.ts). Returns measured
// lengths in samples.
async function prepareTakes(ctx: Ctx, productionId: string, takeIds: string[], workDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!takeIds.length) return result;
  const takes = await ctx.sql<TakeAudioRow[]>`
    select id, storage_key, normalized_key, normalized_samples, stream_key from takes where id = any(${takeIds}::uuid[])`;
  for (const take of takes) {
    const { samples } = await normalizedTake(ctx, productionId, take, { flacTo: path.join(workDir, `take-${take.id}.flac`) });
    result.set(take.id, samples);
  }
  return result;
}
