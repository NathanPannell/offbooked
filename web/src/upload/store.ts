import type { UploadItem } from "./queue";

/** Takes waiting to upload. Audio is stored as an ArrayBuffer: older Safari can't store Blobs. */
export interface TakeStore {
  list(): Promise<UploadItem[]>;
  put(item: UploadItem, audio: ArrayBuffer): Promise<void>;
  update(item: UploadItem): Promise<void>;
  audio(takeId: string): Promise<ArrayBuffer | null>;
  remove(takeId: string): Promise<void>;
}

interface Row extends UploadItem {
  audio: ArrayBuffer;
}

const DB_NAME = "offbooked";
const STORE = "takes";

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "takeId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

function strip(row: Row): UploadItem {
  const { audio: _audio, ...item } = row;
  return item;
}

class IdbTakeStore implements TakeStore {
  constructor(private db: IDBDatabase) {}

  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const tx = this.db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await promisify(fn(tx.objectStore(STORE)));
    await done;
    return result;
  }

  async list() {
    const rows = await this.run<Row[]>("readonly", (s) => s.getAll() as IDBRequest<Row[]>);
    return rows.map(strip);
  }

  async put(item: UploadItem, audio: ArrayBuffer) {
    await this.run("readwrite", (s) => s.put({ ...item, audio } satisfies Row));
  }

  async update(item: UploadItem) {
    const row = await this.run<Row | undefined>("readonly", (s) => s.get(item.takeId) as IDBRequest<Row | undefined>);
    if (row) await this.run("readwrite", (s) => s.put({ ...row, ...item }));
  }

  async audio(takeId: string) {
    const row = await this.run<Row | undefined>("readonly", (s) => s.get(takeId) as IDBRequest<Row | undefined>);
    return row?.audio ?? null;
  }

  async remove(takeId: string) {
    await this.run("readwrite", (s) => s.delete(takeId));
  }
}

/** Fallback when IndexedDB is unavailable: takes survive only until the tab closes. */
class MemoryTakeStore implements TakeStore {
  private rows = new Map<string, Row>();
  async list() {
    return [...this.rows.values()].map(strip);
  }
  async put(item: UploadItem, audio: ArrayBuffer) {
    this.rows.set(item.takeId, { ...item, audio });
  }
  async update(item: UploadItem) {
    const row = this.rows.get(item.takeId);
    if (row) this.rows.set(item.takeId, { ...row, ...item });
  }
  async audio(takeId: string) {
    return this.rows.get(takeId)?.audio ?? null;
  }
  async remove(takeId: string) {
    this.rows.delete(takeId);
  }
}

export async function openTakeStore(): Promise<{ store: TakeStore; persistent: boolean }> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("No IndexedDB");
    return { store: new IdbTakeStore(await openDb()), persistent: true };
  } catch {
    return { store: new MemoryTakeStore(), persistent: false };
  }
}
