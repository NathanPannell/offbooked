// Objects are written once. The only delete is deletePrefix, which the retention job
// (src/retention.ts) uses to remove a production's whole folder for good: it is irreversible.
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
  // Deletes every object whose key starts with prefix (which must end in "/"). Returns how many
  // objects went. Deleting nothing is not an error, so it is safe to run again.
  deletePrefix(prefix: string): Promise<number>;
  // Deletes these objects (any that are already gone are skipped). Returns how many keys it was given.
  deleteKeys(keys: string[]): Promise<number>;
}

export const AUDIO_URL_TTL_SECONDS = 3600;

const CONTENT_TYPES: Record<string, string> = {
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
};

export function contentTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function assertSafePrefix(prefix: string): void {
  assertSafeKey(prefix);
  if (!prefix.endsWith("/") || prefix.split("/").filter(Boolean).length < 2) throw new Error(`Unsafe storage prefix: ${prefix}`);
}

export function assertSafeKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
