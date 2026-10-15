import type { AudioSource, LineAudio, LineAudioApi } from "../api/types";

/** A line's playable audio: a local blob URL (or the signed URL when it can't be downloaded), or null for silence. */
export interface Clip {
  lineId: string;
  url: string | null;
  durationMs: number;
  source: AudioSource;
}

interface Entry {
  clip: Clip;
  blob: boolean;
  at: number;
}

const MAX_BLOBS = 60;
// Signed URLs last an hour; refetch a remote one well before that.
const REMOTE_TTL_MS = 40 * 60_000;
// The line someone is waiting for asks again this many times (the server holds each request up
// to 20 s while the clip is made) before it plays as silence. A prefetch asks once (the server
// holds it up to 8 s) and is asked for again from the next line, so it never blocks the ones after.
export const PLAY_RETRIES = 2;
const RETRY_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches, caches and prefetches each line's clip for the player. Clips are downloaded into blob
 * URLs so the next line starts instantly, even on iOS where an <audio> element only buffers what
 * it is playing. If the download is refused (no CORS on the bucket), it plays the signed URL.
 */
export class ClipLoader {
  private entries = new Map<string, Entry>();
  private loading = new Map<string, { promise: Promise<Clip>; prefetch: boolean }>();
  private warmed = new Set<string>();
  private disposed = false;
  /** Called when a line's audio source becomes known, for the run-through's tags. */
  onSource: ((lineId: string, source: AudioSource) => void) | null = null;

  constructor(
    private api: LineAudioApi,
    private fallbackMs: (lineId: string) => number,
  ) {}

  /** The clip, if it is ready to play now. */
  ready(lineId: string): Clip | undefined {
    const e = this.entries.get(lineId);
    if (!e) return undefined;
    if (!e.blob && e.clip.url && Date.now() - e.at > REMOTE_TTL_MS) {
      this.entries.delete(lineId);
      return undefined;
    }
    return e.clip;
  }

  /** Drops a clip (e.g. its signed URL expired), so the next load fetches it again. */
  invalidate(lineId: string) {
    const e = this.entries.get(lineId);
    if (e?.blob && e.clip.url) URL.revokeObjectURL(e.clip.url);
    this.entries.delete(lineId);
  }

  /**
   * The clip for a line, fetching it when needed. Waits while the server is still making it. On
   * failure the line plays as silence of placeholder length, so playback never stalls for good.
   *
   * The line the player is waiting on is always asked for at play priority, even while a prefetch
   * of it is still out: otherwise it would wait behind every other prefetch and warm-up on the
   * server, at the moment it matters most (that was the stall at the start of a new scene).
   */
  load(lineId: string, opts: { prefetch?: boolean } = {}): Promise<Clip> {
    const have = this.ready(lineId);
    if (have) return Promise.resolve(have);
    const prefetch = Boolean(opts.prefetch);
    const running = this.loading.get(lineId);
    if (running && (prefetch || !running.prefetch)) return running.promise;
    const promise: Promise<Clip> = this.fetchClip(lineId, prefetch).finally(() => {
      if (this.loading.get(lineId)?.promise === promise) this.loading.delete(lineId);
    });
    this.loading.set(lineId, { promise, prefetch });
    return promise;
  }

  /** True while a line's clip is being fetched at play priority (for tests). */
  waitingOn(lineId: string): boolean {
    return this.loading.get(lineId)?.prefetch === false;
  }

  /** Downloads the next few clips (in order, two at a time). */
  prefetch(lineIds: string[]) {
    const todo = lineIds.filter((id) => !this.ready(id));
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !this.disposed) await this.load(todo[next++], { prefetch: true }).catch(() => undefined);
    };
    void worker();
    void worker();
  }

  /** Asks the server to start making clips further ahead. Each line is asked for once. */
  warm(lineIds: string[]) {
    const fresh = lineIds.filter((id) => !this.warmed.has(id) && !this.entries.has(id) && !this.loading.has(id)).slice(0, 30);
    if (!fresh.length) return;
    fresh.forEach((id) => this.warmed.add(id));
    void this.api
      .warm(fresh)
      .then(({ lines }) => lines.forEach((l) => this.onSource?.(l.lineId, l.source)))
      .catch(() => fresh.forEach((id) => this.warmed.delete(id)));
  }

  private async fetchClip(lineId: string, prefetch: boolean): Promise<Clip> {
    let audio: LineAudio | null = null;
    try {
      const attempts = prefetch ? 1 : 1 + PLAY_RETRIES;
      for (let attempt = 0; attempt < attempts && !this.disposed; attempt++) {
        if (attempt > 0) await sleep(RETRY_MS);
        audio = await this.api.line(lineId, { prefetch });
        if (audio.ready) break;
      }
    } catch {
      audio = null;
    }
    if (!audio?.ready) {
      // Not this time: play silence now and ask again next time round.
      return { lineId, url: null, durationMs: this.fallbackMs(lineId), source: audio?.source ?? "none" };
    }
    this.onSource?.(lineId, audio.source);
    let url = audio.audioUrl;
    let blob = false;
    if (url) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          url = URL.createObjectURL(await res.blob());
          blob = true;
        }
      } catch {
        // Cross-origin download refused: the <audio> element can still stream the signed URL.
      }
    }
    const clip: Clip = { lineId, url, durationMs: audio.durationMs, source: audio.source };
    if (this.disposed) {
      if (blob && url) URL.revokeObjectURL(url);
      return clip;
    }
    this.store(clip, blob);
    return clip;
  }

  private store(clip: Clip, blob: boolean) {
    this.entries.delete(clip.lineId);
    this.entries.set(clip.lineId, { clip, blob, at: Date.now() });
    if (this.entries.size > MAX_BLOBS) {
      // The oldest fetched are lines already played (or skipped past).
      const [oldest] = this.entries.keys();
      this.invalidate(oldest);
    }
  }

  dispose() {
    this.disposed = true;
    for (const id of [...this.entries.keys()]) this.invalidate(id);
  }
}
