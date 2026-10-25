import { actorApi, type TakePart, type TakePartResult, type TakeUploadResult } from "../api/actor";
import { ApiError, errorMessage } from "../api/client";
import { standins } from "../api/director";
import { uuid } from "../lib/uuid";
import { backoffMs, enqueue, nextDue, nextWakeAt, transition, type QueueEvent, type TakeKind, type UploadItem } from "./queue";
import { isNativeApp } from "../native/platform";
import { connectNativeUploads, nativeBusyChange, openNativeTakeStore } from "../native/uploads";
import { MemoryTakeStore, openTakeStore, type TakeStore } from "./store";

export interface NewTake {
  /** Defaults to "invite". */
  kind?: TakeKind;
  /** The invite token, or the production ID for a director's take. */
  token: string;
  lineId: string;
  /** A director's take on a shared line: the character it voices. */
  characterId?: string | null;
  audio: Blob;
  durationMs: number;
}

/** A take bigger than this goes up in parts (the server takes up to 8 MB a request). */
export const PART_BYTES = 6 * 1024 * 1024;

/**
 * Uploads a take in one request, or a long one as byte ranges of the same file that the server
 * joins back together. Parts the server reports missing (say, after it restarted) are sent again.
 */
export async function sendInParts(
  blob: Blob,
  send: (body: Blob, part?: TakePart) => Promise<TakeUploadResult | TakePartResult>,
  partBytes = PART_BYTES,
): Promise<TakeUploadResult> {
  if (blob.size <= partBytes) {
    const result = await send(blob);
    if ("take" in result) return result;
    throw new ApiError(0, "upload_incomplete", "The take didn't finish uploading. Trying again.", null);
  }
  const total = Math.ceil(blob.size / partBytes);
  let todo = Array.from({ length: total }, (_, i) => i);
  for (let round = 0; round < 3 && todo.length; round++) {
    let last: TakeUploadResult | TakePartResult | null = null;
    for (const index of todo) {
      last = await send(blob.slice(index * partBytes, (index + 1) * partBytes, blob.type), { index, total });
      // Already saved (a retry after the answer was lost): done.
      if ("take" in last) return last;
    }
    todo = last && "missing" in last ? last.missing : [];
  }
  throw new ApiError(0, "upload_incomplete", "The take didn't finish uploading. Trying again.", null);
}

type SavedListener = (item: UploadItem, result: TakeUploadResult) => void;

/** Sends one request of a take: the whole take, or one part of a long one. */
export type SendTake = (item: UploadItem, body: Blob, part: TakePart | undefined, signal: AbortSignal) => Promise<TakeUploadResult | TakePartResult>;

const sendTake: SendTake = (item, body, part, signal) =>
  item.kind === "director"
    ? standins.putTake(item.lineId, body, item.takeId, item.durationMs, signal, item.characterId, part)
    : actorApi(item.token).putTake(item.lineId, body, item.takeId, item.durationMs, signal, part);

/**
 * How long one request may take before it counts as stalled: 30 s, plus the time to send the body
 * at 16 KB/s (a weak phone signal). Without it, a request the network dropped silently stayed
 * "Saving…" forever and held up every take behind it.
 */
export function stallTimeoutMs(bytes: number): number {
  return 30_000 + Math.ceil((bytes / (16 * 1024)) * 1000);
}

export interface UploaderOptions {
  openStore?: () => Promise<{ store: TakeStore; persistent: boolean }>;
  send?: SendTake;
  stallTimeoutMs?: (bytes: number) => number;
  random?: () => number;
  /** Told when an upload starts (true) and when nothing is left to send right now (false). */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * Persists every take to IndexedDB before uploading, then uploads one at a time with backoff.
 * Survives reloads, crashes and reconnects, and never gives up on a take that can still land.
 * Recording never waits on it.
 */
export class Uploader {
  private items: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private savedListeners = new Set<SavedListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = false;
  private ready: Promise<TakeStore>;
  /**
   * Failures in a row, whichever takes they were. The whole queue waits after one, so a server that
   * refuses takes (or a dead signal) gets one request at a time with growing gaps, not every waiting
   * take in turn. That burst used to use up the take rate limit, so takes kept failing afterwards.
   */
  private failStreak = 0;
  private holdUntil = 0;
  private askedToPersist = false;
  /** Takes the device wouldn't store (full, or private browsing): kept in memory and sent all the same. */
  private spill = new MemoryTakeStore();
  private send: SendTake;
  private stallMs: (bytes: number) => number;
  private random: () => number;
  private onBusyChange: (busy: boolean) => void;
  private working = false;
  persistent = true;

  constructor(opts: UploaderOptions = {}) {
    this.send = opts.send ?? sendTake;
    this.stallMs = opts.stallTimeoutMs ?? stallTimeoutMs;
    this.random = opts.random ?? Math.random;
    this.onBusyChange = opts.onBusyChange ?? (() => {});
    this.ready = (opts.openStore ?? openTakeStore)().then(async ({ store, persistent }) => {
      this.persistent = persistent;
      const now = Date.now();
      const stored = await store.list().catch(() => []);
      // Saved takes are deleted as they land; anything left (cut off, waiting or failed) goes again.
      this.items = stored.filter((i) => i.status !== "saved").map((i) => transition(i, { type: "resume", now }));
      this.emit();
      return store;
    });
    window.addEventListener("online", this.onOnline);
    void this.ready.then(() => this.pump());
  }

  getItems = (): UploadItem[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onSaved(listener: SavedListener): () => void {
    this.savedListeners.add(listener);
    return () => this.savedListeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** Stores the take locally and queues it. Resolves with its client take ID once persisted. */
  async add(take: NewTake): Promise<string> {
    const store = await this.ready;
    const item: UploadItem = {
      takeId: uuid(),
      kind: take.kind ?? "invite",
      token: take.token,
      lineId: take.lineId,
      characterId: take.characterId ?? null,
      mime: take.audio.type,
      durationMs: take.durationMs,
      createdAt: Date.now(),
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      error: null,
      errorCode: null,
    };
    const audio = await take.audio.arrayBuffer();
    let kept = item;
    try {
      await store.put(item, audio);
      this.askToPersist();
      if (!this.persistent) kept = { ...item, volatile: true };
    } catch {
      // Uploading still beats losing the take; it only can't survive the tab closing.
      await this.spill.put(item, audio);
      kept = { ...item, volatile: true };
    }
    const { items, superseded } = enqueue(this.items, kept);
    this.items = items;
    await Promise.all(superseded.map((id) => Promise.all([store.remove(id).catch(() => {}), this.spill.remove(id)])));
    this.emit();
    void this.pump();
    return item.takeId;
  }

  /** Asks the browser not to clear the takes under storage pressure (once; it may say no). */
  private askToPersist() {
    if (this.askedToPersist || !this.persistent) return;
    this.askedToPersist = true;
    void navigator.storage?.persist?.().catch(() => false);
  }

  /** A take still on this device, to play back, or null once it has gone (it landed, or was replaced). */
  async audio(takeId: string): Promise<Blob | null> {
    const item = this.items.find((i) => i.takeId === takeId);
    const audio = await this.audioBytes(await this.ready, takeId).catch(() => null);
    return audio ? new Blob([audio], { type: item?.mime || "audio/webm" }) : null;
  }

  private async audioBytes(store: TakeStore, takeId: string): Promise<ArrayBuffer | null> {
    return (await this.spill.audio(takeId)) ?? store.audio(takeId);
  }

  /** Tries a take now: a failed one from scratch, a waiting one without its wait. */
  retry(takeId: string) {
    this.holdUntil = 0;
    this.apply(takeId, { type: "retry", now: Date.now() });
    void this.pump();
  }

  /** Tries every take that hasn't landed, now. */
  retryAll() {
    this.holdUntil = 0;
    const now = Date.now();
    for (const item of this.items) if (item.status === "failed" || item.status === "queued") this.apply(item.takeId, { type: "retry", now });
    void this.pump();
  }

  private apply(takeId: string, event: QueueEvent): UploadItem | undefined {
    let updated: UploadItem | undefined;
    this.items = this.items.map((i) => (i.takeId === takeId ? (updated = transition(i, event)) : i));
    if (updated) {
      const item = updated;
      void this.ready
        .then(async (store) => {
          if (item.status !== "saved") return store.update(item);
          await this.spill.remove(takeId);
          await store.remove(takeId);
        })
        // The queue in memory carries on; the take's next change writes its row again.
        .catch(() => {});
      this.emit();
    }
    return updated;
  }

  /** The connection is back (or the app is in front again): try every waiting take now. */
  retryNow(): void {
    this.onOnline();
  }

  private setWorking(working: boolean) {
    if (working === this.working) return;
    this.working = working;
    this.onBusyChange(working);
  }

  private onOnline = () => {
    const now = Date.now();
    this.holdUntil = 0;
    this.items = this.items.map((i) => transition(i, { type: "online", now }));
    this.emit();
    void this.pump();
  };

  private schedule(at: number) {
    this.timer = setTimeout(() => void this.pump(), Math.max(0, at - Date.now()));
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const store = await this.ready;
    if (this.busy || this.stopped) return;
    const now = Date.now();
    const item = now < this.holdUntil ? null : nextDue(this.items, now);
    if (!item) {
      const wake = nextWakeAt(this.items);
      if (wake !== null) this.schedule(Math.max(wake, this.holdUntil));
      this.setWorking(false);
      return;
    }

    this.busy = true;
    this.setWorking(true);
    let elsewhere = false;
    try {
      this.apply(item.takeId, { type: "begin" });
      // Tabs on the same device share the stored takes: one uploads at a time, and a take another
      // tab has already sent (or replaced) is simply gone from the store.
      const result = await withUploadLock(async () => {
        if (!(await this.spill.has(item.takeId)) && !(await store.has(item.takeId).catch(() => true))) {
          elsewhere = true;
          return null;
        }
        const audio = await this.audioBytes(store, item.takeId).catch(() => {
          throw new ApiError(0, "storage", "Couldn't read this take on this device. Trying again.", null);
        });
        if (!audio) throw new ApiError(0, "missing_audio", "This take was lost on this device. Record it again.", null);
        const blob = new Blob([audio], { type: item.mime });
        const landed = await sendInParts(blob, (body, part) => this.sendWithTimeout(item, body, part));
        // Gone from the store before the lock is let go, so a tab waiting for it doesn't send it again.
        await Promise.all([this.spill.remove(item.takeId), store.remove(item.takeId).catch(() => {})]);
        return landed;
      });
      if (result) {
        this.failStreak = 0;
        this.holdUntil = 0;
        const saved = this.apply(item.takeId, { type: "succeeded" });
        if (saved) this.savedListeners.forEach((l) => l(saved, result));
      }
    } catch (err) {
      const retryable = err instanceof ApiError ? err.retryable && err.code !== "missing_audio" : true;
      const jitter = this.random() * 2 - 1;
      const retryAfterMs = err instanceof ApiError ? err.retryAfterMs : null;
      if (retryable) {
        this.failStreak++;
        this.holdUntil = Date.now() + Math.max(backoffMs(this.failStreak, jitter), retryAfterMs ?? 0);
      }
      this.apply(item.takeId, {
        type: "failed",
        retryable,
        message: errorMessage(err),
        code: err instanceof ApiError ? err.code : undefined,
        now: Date.now(),
        jitter,
        retryAfterMs,
      });
    } finally {
      this.busy = false;
    }
    if (elsewhere) {
      this.items = this.items.filter((i) => i.takeId !== item.takeId);
      this.emit();
    }
    void this.pump();
  }

  /** One request, cut off (and tried again later) if it hasn't answered in time. */
  private async sendWithTimeout(item: UploadItem, body: Blob, part: TakePart | undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.stallMs(body.size));
    try {
      return await this.send(item, body, part, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new ApiError(0, "timeout", "The upload stalled. Trying again.", null);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener("online", this.onOnline);
    this.listeners.clear();
    this.savedListeners.clear();
  }
}

/**
 * The server's id for a take recorded on this screen: straight away once it has landed, else when
 * its upload does (null after `timeoutMs`, say offline). Lets Delete show the moment a take is kept.
 */
export function savedTakeId(
  uploader: Pick<Uploader, "onSaved">,
  known: ReadonlyMap<string, string>,
  clientTakeId: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  const id = known.get(clientTakeId);
  if (id) return Promise.resolve(id);
  return new Promise((resolve) => {
    const off = uploader.onSaved((item, result) => {
      if (item.takeId !== clientTakeId) return;
      clearTimeout(timer);
      off();
      resolve(result.take.id);
    });
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
  });
}

/** How long a tab waits for another tab's upload before going ahead anyway. */
export const LOCK_WAIT_MS = 30_000;

/**
 * Runs `fn` while holding the device-wide upload lock, where the browser has Web Locks. The wait is
 * bounded: a tab frozen in the background mid-upload keeps its lock (its timers don't run), and
 * waiting on it for good would stall this tab's takes. Going ahead without it is safe, because a
 * repeated X-Take-Id returns the take already saved.
 */
export async function withUploadLock<T>(
  fn: () => Promise<T>,
  waitMs = LOCK_WAIT_MS,
  locks: LockManager | null = typeof navigator === "undefined" ? null : (navigator.locks ?? null),
): Promise<T> {
  if (!locks) return fn();
  const waited = new AbortController();
  const timer = setTimeout(() => waited.abort(), waitMs);
  let granted = false;
  try {
    return (await locks.request("offbooked.uploads", { signal: waited.signal }, () => {
      granted = true;
      clearTimeout(timer);
      return fn();
    })) as T;
  } catch (err) {
    if (!granted && waited.signal.aborted) return fn();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

let shared: Uploader | null = null;

/** One uploader per tab, shared by every screen. In the iOS app its takes are files (native/uploads.ts). */
export function getUploader(): Uploader {
  if (shared) return shared;
  if (isNativeApp()) {
    shared = new Uploader({ openStore: () => openNativeTakeStore(), onBusyChange: nativeBusyChange });
    connectNativeUploads(shared);
  } else {
    shared = new Uploader();
  }
  return shared;
}
