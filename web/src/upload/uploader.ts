import { actorApi, type TakeUploadResult } from "../api/actor";
import { ApiError, errorMessage } from "../api/client";
import { standins } from "../api/director";
import { uuid } from "../lib/uuid";
import { enqueue, nextDue, nextWakeAt, transition, type QueueEvent, type TakeKind, type UploadItem } from "./queue";
import { openTakeStore, type TakeStore } from "./store";

export interface NewTake {
  /** Defaults to "invite". */
  kind?: TakeKind;
  /** The invite token, or the production ID for a director stand-in take. */
  token: string;
  lineId: string;
  /** A director's stand-in on a shared line: the character it voices. */
  characterId?: string | null;
  audio: Blob;
  durationMs: number;
}

type SavedListener = (item: UploadItem, result: TakeUploadResult) => void;

/**
 * Persists every take to IndexedDB before uploading, then uploads one at a time with
 * backoff. Survives reloads and reconnects. Recording never waits on it.
 */
export class Uploader {
  private items: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private savedListeners = new Set<SavedListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = false;
  private ready: Promise<TakeStore>;
  persistent = true;

  constructor() {
    this.ready = openTakeStore().then(async ({ store, persistent }) => {
      this.persistent = persistent;
      const now = Date.now();
      const stored = await store.list().catch(() => []);
      // Saved takes are deleted as they land; anything left resumes.
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
    };
    await store.put(item, await take.audio.arrayBuffer());
    const { items, superseded } = enqueue(this.items, item);
    this.items = items;
    await Promise.all(superseded.map((id) => store.remove(id).catch(() => {})));
    this.emit();
    void this.pump();
    return item.takeId;
  }

  retry(takeId: string) {
    this.apply(takeId, { type: "retry", now: Date.now() });
    void this.pump();
  }

  private apply(takeId: string, event: QueueEvent): UploadItem | undefined {
    let updated: UploadItem | undefined;
    this.items = this.items.map((i) => (i.takeId === takeId ? (updated = transition(i, event)) : i));
    if (updated) {
      void this.ready.then((store) => (updated!.status === "saved" ? store.remove(takeId) : store.update(updated!)));
      this.emit();
    }
    return updated;
  }

  private onOnline = () => {
    const now = Date.now();
    this.items = this.items.map((i) => transition(i, { type: "online", now }));
    this.emit();
    void this.pump();
  };

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const store = await this.ready;
    const item = nextDue(this.items, Date.now());
    if (!item) {
      const wake = nextWakeAt(this.items);
      if (wake !== null) this.timer = setTimeout(() => void this.pump(), Math.max(0, wake - Date.now()));
      return;
    }

    this.busy = true;
    this.apply(item.takeId, { type: "begin" });
    try {
      const audio = await store.audio(item.takeId);
      if (!audio) throw new ApiError(0, "missing_audio", "This take was lost on this device. Record it again.", null);
      const blob = new Blob([audio], { type: item.mime });
      const result =
        item.kind === "director"
          ? await standins.putTake(item.lineId, blob, item.takeId, item.durationMs, undefined, item.characterId)
          : await actorApi(item.token).putTake(item.lineId, blob, item.takeId, item.durationMs);
      const saved = this.apply(item.takeId, { type: "succeeded" });
      if (saved) this.savedListeners.forEach((l) => l(saved, result));
    } catch (err) {
      const retryable = err instanceof ApiError ? err.retryable && err.code !== "missing_audio" : true;
      this.apply(item.takeId, {
        type: "failed",
        retryable,
        message: errorMessage(err),
        now: Date.now(),
        jitter: Math.random() * 2 - 1,
      });
    } finally {
      this.busy = false;
    }
    void this.pump();
  }

  dispose() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener("online", this.onOnline);
    this.listeners.clear();
    this.savedListeners.clear();
  }
}

let shared: Uploader | null = null;

/** One uploader per tab, shared by every screen. */
export function getUploader(): Uploader {
  shared ??= new Uploader();
  return shared;
}
