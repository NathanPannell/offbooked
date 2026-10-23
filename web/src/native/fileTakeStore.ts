import type { UploadItem } from "../upload/queue";
import type { TakeStore } from "../upload/store";

/**
 * Files in the app's own container, the bits of @capacitor/filesystem the take store needs, so
 * tests can pass a map. Paths are relative to one folder.
 */
export interface TakeFiles {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBase64(path: string): Promise<string | null>;
  writeBase64(path: string, data: string): Promise<void>;
  list(): Promise<string[]>;
  remove(path: string): Promise<void>;
}

const ROW = ".json";
const AUDIO = ".audio";

/** ArrayBuffer to base64, in slices so a long take never builds one giant argument list. */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const safeId = (takeId: string) => takeId.replace(/[^a-zA-Z0-9-]/g, "_");

/**
 * The iOS app keeps takes waiting to upload as files in its own Library folder (two per take: the
 * recording, then its UploadItem), not in the web view's IndexedDB, which iOS may clear when the
 * phone runs short of space. The uploader (upload/uploader.ts) is the same as on the website: it
 * sends one take at a time, retries with backoff, and resumes whenever the app opens or the phone
 * gets a signal back (native/network.ts).
 */
export class FileTakeStore implements TakeStore {
  constructor(private files: TakeFiles) {}

  async list(): Promise<UploadItem[]> {
    const names = (await this.files.list()).filter((n) => n.endsWith(ROW));
    const rows = await Promise.all(names.map((n) => this.files.readText(n).then(parseRow)));
    return rows.filter((r): r is UploadItem => r !== null).sort((a, b) => a.createdAt - b.createdAt);
  }

  // The recording goes first: a row is only ever there with its audio beside it.
  async put(item: UploadItem, audio: ArrayBuffer): Promise<void> {
    const id = safeId(item.takeId);
    await this.files.writeBase64(id + AUDIO, toBase64(audio));
    await this.files.writeText(id + ROW, JSON.stringify(item));
  }

  /** Only a take that is still here: a status change never brings a removed take back. */
  async update(item: UploadItem): Promise<void> {
    if (await this.has(item.takeId)) await this.files.writeText(safeId(item.takeId) + ROW, JSON.stringify(item));
  }

  async audio(takeId: string): Promise<ArrayBuffer | null> {
    const data = await this.files.readBase64(safeId(takeId) + AUDIO);
    return data === null ? null : fromBase64(data);
  }

  async has(takeId: string): Promise<boolean> {
    return (await this.files.readText(safeId(takeId) + ROW)) !== null;
  }

  async remove(takeId: string): Promise<void> {
    const id = safeId(takeId);
    await this.files.remove(id + ROW);
    await this.files.remove(id + AUDIO);
  }
}

function parseRow(text: string | null): UploadItem | null {
  if (!text) return null;
  try {
    const row = JSON.parse(text) as UploadItem | null;
    return row && typeof row.takeId === "string" ? row : null;
  } catch {
    return null;
  }
}
