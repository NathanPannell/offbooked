import type { UploadItem } from "./queue";

/** Takes waiting to upload. Audio is stored as an ArrayBuffer: older Safari can't store Blobs. */
export interface TakeStore {
  list(): Promise<UploadItem[]>;
  put(item: UploadItem, audio: ArrayBuffer): Promise<void>;
  update(item: UploadItem): Promise<void>;
  audio(takeId: string): Promise<ArrayBuffer | null>;
  /** Whether the take's row is still here (another tab may have uploaded or replaced it). */
  has(takeId: string): Promise<boolean>;
  remove(takeId: string): Promise<void>;
}

const DB_NAME = "offbooked";
const DB_VERSION = 2;
/** One row per take: its UploadItem. Small, so status changes are cheap. */
const TAKES = "takes";
/** The recording itself, by take id. Written once when the take is kept, read once per attempt. */
const AUDIO = "audio";

interface AudioRow {
  takeId: string;
  audio: ArrayBuffer;
}

/** Version 1 kept the audio inside the take's row, so every status change rewrote the recording. */
type V1Row = UploadItem & { audio?: ArrayBuffer };

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Gives up on an open that never answers (seen on iOS Safari): the memory store takes over. */
const OPEN_TIMEOUT_MS = 5000;

export function openDb(factory: IDBFactory = indexedDB, timeoutMs = OPEN_TIMEOUT_MS): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IndexedDB didn't open")), timeoutMs);
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction!;
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: "takeId" });
      if (!db.objectStoreNames.contains(TAKES)) {
        db.createObjectStore(TAKES, { keyPath: "takeId" });
      } else if (event.oldVersion < 2) {
        // Moves each waiting take's audio into its own store, inside the upgrade, so nothing is lost.
        const takes = tx.objectStore(TAKES);
        const audio = tx.objectStore(AUDIO);
        takes.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const { audio: bytes, ...item } = cursor.value as V1Row;
          if (bytes) audio.put({ takeId: item.takeId, audio: bytes } satisfies AudioRow);
          cursor.update(item);
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    request.onblocked = () => {
      clearTimeout(timer);
      reject(new Error("IndexedDB blocked"));
    };
  });
}

export class IdbTakeStore implements TakeStore {
  /** The connection, or the open that will replace a dropped one. */
  private db: Promise<IDBDatabase>;
  /** The open connection, null while a new one opens. */
  private live: IDBDatabase | null = null;

  constructor(
    db: IDBDatabase,
    private reopen: () => Promise<IDBDatabase>,
  ) {
    this.db = Promise.resolve(this.watch(db));
  }

  /** Safari drops the connection when the page is backgrounded for a while; the next call opens a new one. */
  private watch(db: IDBDatabase): IDBDatabase {
    this.live = db;
    db.onclose = () => this.drop(db);
    db.onversionchange = () => {
      db.close();
      this.drop(db);
    };
    return db;
  }

  /** Replaces a connection that has gone (once, however many callers notice). */
  private drop(db: IDBDatabase) {
    if (this.live !== db) return;
    this.live = null;
    this.replace();
  }

  private replace() {
    this.db = this.reopen().then((db) => this.watch(db));
    this.db.catch(() => {}); // a failed open is tried again by the next call (run)
  }

  private async attempt<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T> | Promise<T>): Promise<T> {
    const tx = db.transaction([TAKES, AUDIO], mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
    });
    done.catch(() => {}); // reported by the awaits below, never as an unhandled rejection
    const out = fn(tx);
    const result = out instanceof Promise ? await out : await promisify(out);
    await done;
    return result;
  }

  /** The connection; when the last open failed (timed out, blocked…), opens again rather than failing for good. */
  private async connection(): Promise<IDBDatabase> {
    const opening = this.db;
    try {
      return await opening;
    } catch {
      if (this.db === opening) this.replace();
      return this.db;
    }
  }

  private async run<T>(mode: IDBTransactionMode, fn: (tx: IDBTransaction) => IDBRequest<T> | Promise<T>): Promise<T> {
    const db = await this.connection();
    try {
      return await this.attempt(db, mode, fn);
    } catch (err) {
      // "Connection to Indexed Database server lost" (UnknownError) or a closed database
      // (InvalidStateError): open it again and try once more.
      const name = err instanceof DOMException ? err.name : "";
      if (name !== "InvalidStateError" && name !== "UnknownError") throw err;
      this.drop(db);
      return this.attempt(await this.connection(), mode, fn);
    }
  }

  async list() {
    return this.run<UploadItem[]>("readonly", (tx) => tx.objectStore(TAKES).getAll() as IDBRequest<UploadItem[]>);
  }

  async put(item: UploadItem, audio: ArrayBuffer) {
    await this.run("readwrite", (tx) => {
      tx.objectStore(AUDIO).put({ takeId: item.takeId, audio } satisfies AudioRow);
      return tx.objectStore(TAKES).put(item);
    });
  }

  /** Only touches the small row; a take removed meanwhile (saved or superseded) stays removed. */
  async update(item: UploadItem) {
    await this.run("readwrite", async (tx) => {
      const takes = tx.objectStore(TAKES);
      if (await promisify(takes.getKey(item.takeId))) await promisify(takes.put(item));
    });
  }

  async audio(takeId: string) {
    const row = await this.run<AudioRow | undefined>("readonly", (tx) => tx.objectStore(AUDIO).get(takeId) as IDBRequest<AudioRow | undefined>);
    return row?.audio ?? null;
  }

  async has(takeId: string) {
    return (await this.run("readonly", (tx) => tx.objectStore(TAKES).getKey(takeId))) !== undefined;
  }

  async remove(takeId: string) {
    await this.run("readwrite", (tx) => {
      tx.objectStore(AUDIO).delete(takeId);
      return tx.objectStore(TAKES).delete(takeId);
    });
  }
}

/** Fallback when IndexedDB is unavailable: takes survive only until the tab closes. */
export class MemoryTakeStore implements TakeStore {
  private rows = new Map<string, { item: UploadItem; audio: ArrayBuffer }>();
  async list() {
    return [...this.rows.values()].map((r) => r.item);
  }
  async put(item: UploadItem, audio: ArrayBuffer) {
    this.rows.set(item.takeId, { item, audio });
  }
  async update(item: UploadItem) {
    const row = this.rows.get(item.takeId);
    if (row) row.item = item;
  }
  async audio(takeId: string) {
    return this.rows.get(takeId)?.audio ?? null;
  }
  async has(takeId: string) {
    return this.rows.has(takeId);
  }
  async remove(takeId: string) {
    this.rows.delete(takeId);
  }
}

export async function openTakeStore(factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB) {
  try {
    if (!factory) throw new Error("No IndexedDB");
    const db = await openDb(factory);
    return { store: new IdbTakeStore(db, () => openDb(factory)) as TakeStore, persistent: true };
  } catch {
    return { store: new MemoryTakeStore() as TakeStore, persistent: false };
  }
}
