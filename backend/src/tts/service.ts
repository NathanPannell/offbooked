import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "../db.ts";
import type { Log } from "../log.ts";
import { encodeCue, normalizeTake } from "../render/ffmpeg.ts";
import type { Storage } from "../storage/storage.ts";
import type { Synthesizer } from "./piper.ts";
import { assignVoices, clipHash, speakable, type Voice } from "./voices.ts";

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

// Runs at most `limit` tasks at once, first come first served.
class Semaphore {
  private free: number;
  private queue: (() => void)[] = [];
  constructor(limit: number) {
    this.free = Math.max(1, limit);
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

// Synthesized speech for unrecorded lines: picks voices, caches clips in storage by content hash
// (table tts_clips) and synthesizes missing ones on a small worker pool. Normalized like takes.
export class TtsService {
  private sql: Sql;
  private storage: Storage;
  private log: Log;
  private synth: Synthesizer;
  private slots: Semaphore;
  private inflight = new Map<string, Promise<TtsClip | null>>();

  constructor(deps: { sql: Sql; storage: Storage; log: Log; synthesizer: Synthesizer; concurrency: number }) {
    this.sql = deps.sql;
    this.storage = deps.storage;
    this.log = deps.log;
    this.synth = deps.synthesizer;
    this.slots = new Semaphore(deps.concurrency);
  }

  // Engine label, or null when TTS can't run here (the synthesizer logs that once).
  engine(): Promise<string | null> {
    return this.synth.probe();
  }

  close(): Promise<void> {
    return this.synth.close();
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

  async cached(hashes: string[]): Promise<Map<string, TtsClip>> {
    if (!hashes.length) return new Map();
    const rows = await this.sql<TtsClip[]>`
      select hash, storage_key, samples, cue_key from tts_clips where hash = any(${[...new Set(hashes)]}::text[])`;
    return new Map(rows.map((r) => [r.hash, r]));
  }

  // Makes sure each requested clip exists (and its .m4a when cue is set). Lines that fail are
  // logged and left out of the result, so callers fall back to silence.
  async ensure(requests: TtsRequest[], opts: { cue?: boolean } = {}): Promise<Map<string, TtsClip>> {
    const unique = [...new Map(requests.map((r) => [r.hash, r])).values()];
    const result = await this.cached(unique.map((r) => r.hash));
    const missing = unique.filter((r) => !result.has(r.hash) || (opts.cue && !result.get(r.hash)!.cueKey));
    // Grouped by model so pooled Piper processes rarely have to switch models.
    missing.sort((a, b) => a.voice.model.localeCompare(b.voice.model));
    const done = await Promise.all(missing.map((r) => this.one(r, result.get(r.hash), Boolean(opts.cue))));
    for (const clip of done) if (clip) result.set(clip.hash, clip);
    return result;
  }

  // Concurrent requests for the same clip (a render and a cue warm-up) share one synthesis.
  private one(r: TtsRequest, existing: TtsClip | undefined, cue: boolean): Promise<TtsClip | null> {
    const running = this.inflight.get(r.hash);
    if (running) return running.then((clip) => (cue && clip && !clip.cueKey ? this.one(r, clip, true) : clip));
    const p: Promise<TtsClip | null> = this.slots
      .use(() => this.make(r, existing, cue))
      .catch((err) => {
        this.log.error({ err, voice: r.voice.id, chars: r.text.length }, "tts clip failed");
        return null;
      })
      .finally(() => {
        if (this.inflight.get(r.hash) === p) this.inflight.delete(r.hash);
      });
    this.inflight.set(r.hash, p);
    return p;
  }

  private async make(r: TtsRequest, existing: TtsClip | undefined, cue: boolean): Promise<TtsClip> {
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-tts-"));
    try {
      let clip = existing ?? (await this.cached([r.hash])).get(r.hash);
      const flac = path.join(dir, "clip.flac");
      const local = !clip;
      if (!clip) {
        const wav = path.join(dir, "clip.wav");
        await this.synth.synthesize(r.text, r.voice, wav);
        const samples = await normalizeTake(wav, flac);
        if (samples <= 0) throw new Error("synthesized clip is empty");
        const storageKey = `tts/${r.hash}.flac`;
        await this.storage.put(storageKey, await readFile(flac), "audio/flac");
        await this.sql`insert into tts_clips (hash, voice, storage_key, samples) values (${r.hash}, ${r.voice.id}, ${storageKey}, ${samples})
                       on conflict (hash) do nothing`;
        clip = { hash: r.hash, storageKey, samples, cueKey: null };
      }
      if (cue && !clip.cueKey) {
        if (!local) await writeFile(flac, await this.storage.get(clip.storageKey));
        const m4a = path.join(dir, "clip.m4a");
        await encodeCue(flac, m4a);
        const cueKey = `tts/${r.hash}.m4a`;
        await this.storage.put(cueKey, await readFile(m4a), "audio/mp4");
        await this.sql`update tts_clips set cue_key = ${cueKey} where hash = ${r.hash}`;
        clip = { ...clip, cueKey };
      }
      return clip;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
