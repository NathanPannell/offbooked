import { createHmac, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIO_URL_TTL_SECONDS, assertSafeKey, type Storage } from "./storage.ts";

// Files under STORAGE_DIR. Signed GET URLs point at the API's own /api/files route.
export class LocalStorage implements Storage {
  readonly root: string;
  private apiUrl: string;
  private secret: string;

  constructor(opts: { dir: string; apiUrl: string; secret: string }) {
    this.root = path.resolve(opts.dir);
    this.apiUrl = opts.apiUrl;
    this.secret = opts.secret;
  }

  pathFor(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds = AUDIO_URL_TTL_SECONDS): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.apiUrl}/api/files/${key}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  verify(key: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(key, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(key: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`file:${key}:${exp}`).digest("base64url");
  }
}
