import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "../db.ts";
import type { Log } from "../log.ts";
import { encodeCue, normalizeClip } from "../render/ffmpeg.ts";
import type { Storage } from "../storage/storage.ts";
import type { Synthesizer } from "./piper.ts";
import { assignVoices, clipHash, NARRATOR, speakable, speakableDirection, type Voice } from "./voices.ts";

export interface TtsClip {
  hash: string;
  storageKey: string; // normalized FLAC
  samples: number;
  cueKey: string | null; // .m4a for cue playback
}

export interface TtsRequest {
  hash: string;
  text: string; // already speakable()
  voice: Voice;
}

// Lower runs first. A listener waiting on a line beats prefetching, which beats cue warm-ups and
// the background render.
export const TTS_PRIORITY = { play: 0, prefetch: 1, cue: 2, render: 3 } as const;
export type TtsPriority = (typeof TTS_PRIORITY)[keyof typeof TTS_PRIORITY];

interface Ticket {
  priority: number;
  seq: number;
  start: (() => void) | null; // set while waiting
}

// Runs at most `limit` tasks at once, by priority and then first come first served. Background work
// (cues and renders) may use only limit - 1 slots, so a listener's line never waits behind a whole
// render; it waits at most for one clip that is already being made. A waiting ticket's priority can
// be raised, e.g. when a listener reaches a line the render had queued.
export class PriorityPool {
  private limit: number;
  private running = 0;
  private runningBackground = 0;
  private waiting: Ticket[] = [];
  private seq = 0;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  private get backgroundLimit(): number {
    return Math.max(1, this.limit - 1);
  }

  private static background(priority: number): boolean {
    return priority >= TTS_PRIORITY.cue;
  }

  ticket(priority: number): Ticket {
    return { priority, seq: this.seq++, start: null };
  }

  raise(t: Ticket, priority: number) {
    if (priority < t.priority) {
      t.priority = priority;
      if (t.start) this.pump();
    }
  }

  get queued(): number {
    return this.waiting.length;
  }

  async use<T>(t: Ticket, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      t.start = resolve;
      this.waiting.push(t);
      this.pump();
    });
    const background = PriorityPool.background(t.priority);
    try {
      return await fn();
    } finally {
      this.running--;
      if (background) this.runningBackground--;
      this.pump();
    }
  }

  private pump() {
    while (this.running < this.limit && this.waiting.length) {
      let best = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        const w = this.waiting[i]!;
        if (PriorityPool.background(w.priority) && this.runningBackground >= this.backgroundLimit) continue;
        const b = this.waiting[best];
        if (!b || w.priority < b.priority || (w.priority === b.priority && w.seq < b.seq)) best = i;
      }
      if (best < 0) return;
      const [t] = this.waiting.splice(best, 1);
      this.running++;
      if (PriorityPool.background(t!.priority)) this.runningBackground++;
      const start = t!.start!;
      t!.start = null;
      start();
    }
  }
}

// Synthesized speech for unrecorded lines: picks voices, caches clips in storage by content hash
// (table tts_clips) and synthesizes missing ones on a small worker pool, by priority. Normalized
// like takes. Every new clip gets both the FLAC the render stitches and the .m4a that cues and
// line-by-line playback use, so the render and the player share clips.
export class TtsService {
  private sql: Sql;
  private storage: Storage;
  private log: Log;
  private synth: Synthesizer;
  private pool: PriorityPool;
  private inflight = new Map<string, { promise: Promise<TtsClip | null>; ticket: Ticket }>();

  constructor(deps: { sql: Sql; storage: Storage; log: Log; synthesizer: Synthesizer; concurrency: number }) {
    this.sql = deps.sql;
    this.storage = deps.storage;
    this.log = deps.log;
    this.synth = deps.synthesizer;
    this.pool = new PriorityPool(deps.concurrency);
  }

  // Engine label, or null when TTS can't run here (the synthesizer logs that once).
  engine(): Promise<string | null> {
    return this.synth.probe();
  }

  close(): Promise<void> {
    return this.synth.close();
  }

  // Starts the synthesizer for these voices ahead of time, when it has room (Piper loads a model
  // per process, which takes about half a second).
  prewarm(voices: Voice[]): void {
    for (const model of new Set(voices.map((v) => v.model))) this.synth.prewarm?.(model);
  }

  // One voice per character, assigned in creation order so existing voices never move.
  async voices(productionId: string): Promise<Map<string, Voice>> {
    const chars = await this.sql<{ id: string; name: string }[]>`
      select id, name from characters where production_id = ${productionId} order by created_at, id`;
    return assignVoices(chars);
  }

  // The clip request for a line, or null when there is nothing to say.
  request(engine: string, voice: Voice | undefined, text: string): TtsRequest | null {
    const spoken = speakable(text);
    if (!voice || !spoken) return null;
    return { hash: clipHash(engine, voice, spoken), text: spoken, voice };
  }

  // A stage direction, read by the narrator (a voice no character has).
  directionRequest(engine: string, text: string): TtsRequest | null {
    const spoken = speakableDirection(text);
    if (!spoken) return null;
    return { hash: clipHash(engine, NARRATOR, spoken), text: spoken, voice: NARRATOR };
  }

  async cached(hashes: string[]): Promise<Map<string, TtsClip>> {
    if (!hashes.length) return new Map();
    const rows = await this.sql<TtsClip[]>`
      select hash, storage_key, samples, cue_key from tts_clips where hash = any(${[...new Set(hashes)]}::text[])`;
    return new Map(rows.map((r) => [r.hash, r]));
  }

  // Makes sure each requested clip exists (and its .m4a when cue is set). Lines that fail are
  // logged and left out of the result, so callers fall back to silence. Requests run in the order
  // given within their priority; the render passes TTS_PRIORITY.render and so yields to listeners.
  async ensure(requests: TtsRequest[], opts: { cue?: boolean; priority?: TtsPriority } = {}): Promise<Map<string, TtsClip>> {
    const priority = opts.priority ?? TTS_PRIORITY.render;
    const unique = [...new Map(requests.map((r) => [r.hash, r])).values()];
    const result = await this.cached(unique.map((r) => r.hash));
    const missing = unique.filter((r) => !result.has(r.hash) || (opts.cue && !result.get(r.hash)!.cueKey));
    // Background batches are grouped by model so pooled Piper processes rarely switch models.
    // Interactive ones keep their order: the first line is the one someone is waiting for.
    if (priority >= TTS_PRIORITY.cue) missing.sort((a, b) => a.voice.model.localeCompare(b.voice.model));
    const done = await Promise.all(missing.map((r) => this.one(r, result.get(r.hash), Boolean(opts.cue), priority)));
    for (const clip of done) if (clip) result.set(clip.hash, clip);
    return result;
  }

  // Clips waiting for a synthesis slot (for logs and tests).
  get queued(): number {
    return this.pool.queued;
  }

  // Concurrent requests for the same clip (a render, a cue warm-up and a listener) share one
  // synthesis, which runs at the most urgent priority anyone asked for.
  private one(r: TtsRequest, existing: TtsClip | undefined, cue: boolean, priority: TtsPriority): Promise<TtsClip | null> {
    const running = this.inflight.get(r.hash);
    if (running) {
      this.pool.raise(running.ticket, priority);
      return running.promise.then((clip) => (cue && clip && !clip.cueKey ? this.one(r, clip, true, priority) : clip));
    }
    const ticket = this.pool.ticket(priority);
    const p: Promise<TtsClip | null> = this.pool
      .use(ticket, () => this.make(r, existing, cue))
      .catch((err) => {
        this.log.error({ err, voice: r.voice.id, chars: r.text.length }, "tts clip failed");
        return null;
      })
      .finally(() => {
        if (this.inflight.get(r.hash)?.promise === p) this.inflight.delete(r.hash);
      });
    this.inflight.set(r.hash, { promise: p, ticket });
    return p;
  }

  private async make(r: TtsRequest, existing: TtsClip | undefined, cue: boolean): Promise<TtsClip> {
    // Another request may have finished this clip while this one waited for a slot.
    let clip = (await this.cached([r.hash])).get(r.hash) ?? existing;
    if (clip && (clip.cueKey || !cue)) return clip;
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-tts-"));
    try {
      const flac = path.join(dir, "clip.flac");
      const m4a = path.join(dir, "clip.m4a");
      if (!clip) {
        const wav = path.join(dir, "clip.wav");
        await this.synth.synthesize(r.text, r.voice, wav);
        const samples = await normalizeClip(wav, flac, m4a);
        if (samples <= 0) throw new Error("synthesized clip is empty");
        const storageKey = `tts/${r.hash}.flac`;
        const cueKey = `tts/${r.hash}.m4a`;
        await Promise.all([
          this.storage.put(storageKey, await readFile(flac), "audio/flac"),
          this.storage.put(cueKey, await readFile(m4a), "audio/mp4"),
        ]);
        await this.sql`insert into tts_clips (hash, voice, storage_key, samples, cue_key) values (${r.hash}, ${r.voice.id}, ${storageKey}, ${samples}, ${cueKey})
                       on conflict (hash) do update set cue_key = coalesce(tts_clips.cue_key, excluded.cue_key)`;
        return { hash: r.hash, storageKey, samples, cueKey };
      }
      // A clip made before every clip had an .m4a.
      await writeFile(flac, await this.storage.get(clip.storageKey));
      await encodeCue(flac, m4a);
      const cueKey = `tts/${r.hash}.m4a`;
      await this.storage.put(cueKey, await readFile(m4a), "audio/mp4");
      await this.sql`update tts_clips set cue_key = ${cueKey} where hash = ${r.hash}`;
      clip = { ...clip, cueKey };
      return clip;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
