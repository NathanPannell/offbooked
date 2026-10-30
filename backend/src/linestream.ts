import type { Ctx } from "./context.ts";
import { badRequest, notFound } from "./errors.ts";
import { body, uuidList } from "./input.ts";
import { placeholderMs, RENDER_SETTINGS, type AudioSource } from "./render/plan.ts";
import { mixedClip, voiceTakes, type VoiceTake } from "./render/mix.ts";
import { isCurrentNormalized, normalizedTake, type TakeAudioRow } from "./render/takeaudio.ts";
import type { Stretch } from "./render/trim.ts";
import { backfillTiming, servedSpeech, servedWordStarts } from "./taketiming.ts";
import { TTS_PRIORITY, type SpokenSegment, type TtsClip, type TtsPriority, type TtsRequest, type TtsService } from "./tts/service.ts";
import type { Voice } from "./tts/voices.ts";

// Line-by-line playback: each dialogue line's audio as its own small .m4a, so the run-through can
// start on the first line instead of waiting for the whole play to be stitched. The source rules
// match the render (take, else TTS, else a silence of placeholder length) and the clips are the
// same cached files, so the render and the player never make anything twice.

export interface LineAudioView {
  lineId: string;
  audioUrl: string | null; // null for a silent line (or one that isn't ready yet)
  durationMs: number; // the clip's length; for a silent line, how long the render's silence lasts
  source: AudioSource;
  ready: boolean; // false while the clip is still being made; ask again
  // A synthesized line: when each sentence (and narrated direction) is said, for highlighting
  // words as they are read. Absent for takes and silent lines.
  segments?: SpokenSegment[];
  // A take (not a mix of several): where the voice is in the clip, split on pauses. Absent for TTS.
  speech?: Stretch[];
  // A take: when each spoken word of the line starts in the clip, as the app heard them while it
  // recorded. Absent when it wasn't heard, or the line has been edited since.
  wordStartsMs?: number[];
}

interface LineAudioRow {
  id: string;
  kind: "dialogue" | "stage_direction";
  characterId: string | null;
  text: string;
  takeId: string | null;
  recordedBy: "actor" | "director" | null;
  storageKey: string | null;
  normalizedKey: string | null;
  normalizedSamples: number | null;
  streamKey: string | null;
  speechMs: number[] | null;
  trimStartMs: number | null;
  wordStartsMs: number[] | null;
  shared: boolean; // said by several characters: their takes play mixed (render/mix.ts)
}

// How long a GET waits for a clip still being made: the line someone is waiting on holds on longer
// than a prefetch, which the player simply asks for again on the next line.
export const LINE_AUDIO_WAIT_MS = 20_000;
export const PREFETCH_WAIT_MS = 8_000;
export const MAX_WARM_LINES = 30;

const samplesToMs = (samples: number) => Math.round((samples * 1000) / RENDER_SETTINGS.sampleRate);

async function rowsFor(ctx: Ctx, productionId: string, lineIds: string[]): Promise<LineAudioRow[]> {
  if (!lineIds.length) return [];
  return ctx.sql<LineAudioRow[]>`
    select l.id, l.kind, l.character_id, l.text, case when l.kind = 'dialogue' then l.current_take_id end as take_id,
      t.recorded_by, t.storage_key, t.normalized_key, t.normalized_samples, t.stream_key, t.speech_ms, t.trim_start_ms, t.aligned_word_starts_ms as word_starts_ms,
      l.voice_ids is not null as shared
    from lines l left join takes t on t.id = l.current_take_id and l.kind = 'dialogue'
    where l.production_id = ${productionId} and l.kind in ('dialogue', 'stage_direction') and l.id = any(${lineIds}::uuid[])`;
}

// The clip request for a line without a take: the character's voice for dialogue (bracketed
// asides left out), the narrator for a stage direction.
const requestFor = (tts: TtsService, engine: string, voices: Map<string, Voice>, r: { kind: string; characterId: string | null; text: string }) =>
  r.kind === "stage_direction" ? tts.directionRequest(engine, r.text) : tts.request(engine, voices.get(r.characterId ?? ""), r.text);

// A line with nothing to play: dialogue keeps a silence as long as the render's; a stage direction
// is simply passed over.
const silentMs = (r: { kind: string; text: string }) => (r.kind === "stage_direction" ? 0 : placeholderMs(r.text));

// Audio for some of a production's dialogue lines and stage directions, in the order asked (unknown ids are left out).
// With `waitMs`, waits that long for clips still being made; without it, starts making them in the
// background and answers at once (ready: false for those). `priority` orders TTS synthesis.
export async function lineAudio(ctx: Ctx, productionId: string, lineIds: string[], opts: { priority: TtsPriority; waitMs?: number }): Promise<LineAudioView[]> {
  const resolved = await resolveLineAudio(ctx, productionId, lineIds, opts);
  return Promise.all(resolved.map(async ({ audioKey, ...view }) => ({ ...view, audioUrl: audioKey ? await ctx.storage.signedUrl(audioKey) : null })));
}

// A line's audio as lineAudio finds it, with the storage key of its .m4a instead of a signed URL:
// the listen track (listentrack.ts) joins these files itself.
export type ResolvedLineAudio = Omit<LineAudioView, "audioUrl"> & { audioKey: string | null };

export async function resolveLineAudio(
  ctx: Ctx,
  productionId: string,
  lineIds: string[],
  opts: { priority: TtsPriority; waitMs?: number },
): Promise<ResolvedLineAudio[]> {
  const rows = new Map((await rowsFor(ctx, productionId, lineIds)).map((r) => [r.id, r]));
  const ordered = lineIds.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []));
  const waitMs = opts.waitMs ?? 0;
  const deadline = (p: Promise<unknown>) => {
    if (waitMs <= 0) return Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      p.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((r) => (timer = setTimeout(r, waitMs))),
    ]).finally(() => clearTimeout(timer));
  };

  // Shared lines: one voice's take plays as it is, two or more play mixed. Without voice takes
  // (only takes from before the line was shared) the current take plays, else TTS.
  const sharedIds = ordered.filter((r) => r.shared).map((r) => r.id);
  const byVoice = sharedIds.length ? await voiceTakes(ctx.sql, productionId, sharedIds) : new Map<string, VoiceTake[]>();
  const mixes = new Map<string, VoiceTake[]>();
  for (const r of ordered) {
    const takes = byVoice.get(r.id);
    if (!takes?.length) continue;
    const t = takes[0]!;
    Object.assign(r, {
      takeId: t.id,
      recordedBy: t.recordedBy,
      storageKey: t.storageKey,
      normalizedKey: t.normalizedKey,
      normalizedSamples: t.normalizedSamples,
      streamKey: t.streamKey,
      speechMs: t.speechMs,
      trimStartMs: t.trimStartMs,
      wordStartsMs: t.wordStartsMs,
    });
    if (takes.length > 1) mixes.set(r.id, takes);
  }

  // A take's word timing, in ms of the clip as served. Takes normalized before takes kept their
  // speech have it worked out once, in the background, for next time.
  const timingOf = (r: LineAudioRow, durationMs: number, fresh: { speechMs?: number[]; trimStartMs?: number; wordStartsMs?: number[] } = {}) => {
    const speechMs = fresh.speechMs ?? r.speechMs;
    if (!speechMs && r.takeId && r.storageKey) {
      const take = { id: r.takeId, storageKey: r.storageKey };
      ctx.jobs.run("work out a take's speech", () => backfillTiming(ctx, take, durationMs));
    }
    const speech = servedSpeech(speechMs, durationMs);
    // Normalized just now (`fresh` has its cut): its own word starts or none, never the row's from before.
    const made = fresh.trimStartMs !== undefined;
    const wordStartsMs = servedWordStarts(made ? (fresh.wordStartsMs ?? null) : r.wordStartsMs, made ? fresh.trimStartMs! : r.trimStartMs, durationMs, r.text);
    return { ...(speech ? { speech } : {}), ...(wordStartsMs ? { wordStartsMs } : {}) };
  };

  // Takes: the normalized .m4a, made on first use.
  const takeViews = new Map<string, ResolvedLineAudio>();
  const takeJobs: Promise<unknown>[] = [];
  for (const [lineId, takes] of mixes) {
    const r = rows.get(lineId)!;
    const source = takes.some((t) => t.recordedBy === "actor") ? "actor" : "director";
    const job = mixedClip(ctx, productionId, takes).then(
      (m) => {
        takeViews.set(lineId, { lineId, audioKey: m.streamKey, durationMs: samplesToMs(m.samples), source, ready: true });
      },
      (err) => {
        ctx.log.warn({ err, lineId }, "mixing a shared line failed");
        takeViews.set(lineId, { lineId, audioKey: null, durationMs: placeholderMs(r.text), source, ready: true });
      },
    );
    ctx.jobs.run("mix shared line for playback", () => job);
    takeJobs.push(job);
  }
  for (const r of ordered) {
    if (!r.takeId || !r.storageKey || mixes.has(r.id)) continue;
    const source = r.recordedBy ?? "actor";
    const row: TakeAudioRow = {
      id: r.takeId,
      storageKey: r.storageKey,
      normalizedKey: r.normalizedKey,
      normalizedSamples: r.normalizedSamples,
      streamKey: r.streamKey,
    };
    if (r.streamKey && r.normalizedSamples && isCurrentNormalized(r.normalizedKey)) {
      const durationMs = samplesToMs(r.normalizedSamples);
      takeViews.set(r.id, {
        lineId: r.id,
        audioKey: r.streamKey,
        durationMs,
        source,
        ready: true,
        ...timingOf(r, durationMs),
      });
      continue;
    }
    const job = normalizedTake(ctx, productionId, row, { stream: true, priority: opts.priority }).then(
      (t) => {
        const durationMs = samplesToMs(t.samples);
        takeViews.set(r.id, {
          lineId: r.id,
          audioKey: t.streamKey ?? null,
          durationMs,
          source,
          ready: true,
          ...timingOf(r, durationMs, t),
        });
      },
      (err) => {
        // An unreadable take plays as silence rather than stalling the run-through.
        ctx.log.warn({ err, takeId: r.takeId }, "take normalize failed");
        takeViews.set(r.id, { lineId: r.id, audioKey: null, durationMs: placeholderMs(r.text), source, ready: true });
      },
    );
    ctx.jobs.run("normalize take for playback", () => job);
    takeJobs.push(job);
  }

  // Everything else: the line's TTS clip, synthesized at the given priority when missing.
  const tts = ctx.tts;
  const engine = tts && ordered.some((r) => !r.takeId) ? await tts.engine() : null;
  const requests = new Map<string, TtsRequest>();
  let clips = new Map<string, TtsClip>();
  let ttsJob: Promise<unknown> = Promise.resolve();
  let ttsSettled = true;
  if (tts && engine) {
    const voices = await tts.voices(productionId);
    for (const r of ordered) {
      if (r.takeId) continue;
      const req = requestFor(tts, engine, voices, r);
      if (req) requests.set(r.id, req);
    }
    tts.prewarm([...requests.values()].map((q) => q.voice));
    clips = await tts.cached(
      [...requests.values()].map((q) => q.hash),
      productionId,
    );
    const missing = [...requests.values()].filter((q) => !clips.get(q.hash)?.cueKey);
    if (missing.length) {
      ttsSettled = false;
      const pending = tts.ensure(missing, { cue: true, priority: opts.priority, productionId }).then((made) => {
        for (const [hash, clip] of made) clips.set(hash, clip);
        ttsSettled = true;
      });
      ctx.jobs.run("tts for playback", () => pending);
      ttsJob = pending;
    }
  }

  await deadline(Promise.all([...takeJobs, ttsJob]));

  return ordered.map((r): ResolvedLineAudio => {
    if (r.takeId && r.storageKey) {
      const view = takeViews.get(r.id);
      if (view) return view;
      return { lineId: r.id, audioKey: null, durationMs: placeholderMs(r.text), source: r.recordedBy ?? "actor", ready: false };
    }
    const req = requests.get(r.id);
    const key = req ? clips.get(req.hash)?.cueKey : null;
    if (req && key) {
      return {
        lineId: r.id,
        audioKey: key,
        durationMs: samplesToMs(clips.get(req.hash)!.samples),
        source: "tts",
        ready: true,
        ...(clips.get(req.hash)!.timings ? { segments: clips.get(req.hash)!.timings! } : {}),
      };
    }
    // Still being synthesized, or no TTS here (or synthesis failed): silent, like the render.
    if (req && !ttsSettled) return { lineId: r.id, audioKey: null, durationMs: silentMs(r), source: "tts", ready: false };
    return { lineId: r.id, audioKey: null, durationMs: silentMs(r), source: "none", ready: true };
  });
}

// One line, waiting for its clip. 404 when the line isn't a dialogue line or stage direction of this production.
export async function oneLineAudio(ctx: Ctx, productionId: string, lineId: string, priority: TtsPriority): Promise<LineAudioView> {
  const waitMs = priority === TTS_PRIORITY.play ? LINE_AUDIO_WAIT_MS : PREFETCH_WAIT_MS;
  const [view] = await lineAudio(ctx, productionId, [lineId], { priority, waitMs });
  if (!view) throw notFound("Line not found.");
  return view;
}

// The ids in a warm request: up to MAX_WARM_LINES, in playback order.
export function warmIds(raw: unknown): string[] {
  const ids = uuidList(body(raw), "lineIds", true)!;
  if (ids.length > MAX_WARM_LINES) throw badRequest(`lineIds can list at most ${MAX_WARM_LINES} lines.`);
  return ids.map((id) => id.toLowerCase());
}

export const playPriority = (prefetch: unknown): TtsPriority => (prefetch === "1" || prefetch === "true" ? TTS_PRIORITY.prefetch : TTS_PRIORITY.play);

// Where each dialogue line's (and stage direction's) audio will come from, without making
// anything: the current take's recorder, else "tts" when TTS can voice it, else "none". The player
// shows these as tags.
export async function lineSources(ctx: Ctx, productionId: string): Promise<Record<string, AudioSource>> {
  const rows = await ctx.sql<
    { id: string; kind: string; characterId: string | null; text: string; recordedBy: "actor" | "director" | null; takeId: string | null }[]
  >`
    select l.id, l.kind, l.character_id, l.text, case when l.kind = 'dialogue' then l.current_take_id end as take_id, t.recorded_by
    from lines l left join takes t on t.id = l.current_take_id and l.kind = 'dialogue'
    where l.production_id = ${productionId} and l.kind in ('dialogue', 'stage_direction') order by l.seq`;
  const tts = ctx.tts;
  const engine = tts && rows.some((r) => !r.takeId) ? await tts.engine() : null;
  const voices = tts && engine ? await tts.voices(productionId) : new Map();
  const out: Record<string, AudioSource> = {};
  const upcoming: TtsRequest[] = [];
  for (const r of rows) {
    if (r.takeId) out[r.id] = r.recordedBy ?? "actor";
    else {
      const req = tts && engine ? requestFor(tts, engine, voices, r) : null;
      out[r.id] = req ? "tts" : "none";
      if (req && upcoming.length < 12) upcoming.push(req);
    }
  }
  // Someone is about to press play: load the voices the opening lines need.
  if (tts && upcoming.length) tts.prewarm(upcoming.map((q) => q.voice));
  return out;
}
