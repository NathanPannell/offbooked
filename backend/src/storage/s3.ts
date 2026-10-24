import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AUDIO_URL_TTL_SECONDS, assertSafeKey, assertSafePrefix, type Storage } from "./storage.ts";

// S3-compatible bucket (Railway buckets use virtual-host style URLs). Range requests are native.
export class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;

  constructor(opts: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: false,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty object ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") return false;
      throw err;
    }
  }

  // Lists a page (up to 1000 keys), deletes it in one request, and repeats until the prefix is empty.
  async deletePrefix(prefix: string): Promise<number> {
    assertSafePrefix(prefix);
    let count = 0;
    for (;;) {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000 }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (!keys.length) return count;
      const res = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      if (res.Errors?.length) throw new Error(`Deleting ${prefix} failed for ${res.Errors.length} objects: ${res.Errors[0]?.Message ?? "unknown error"}`);
      count += keys.length;
    }
  }

  // In requests of up to 1000 keys, the most one DeleteObjects takes.
  async deleteKeys(keys: string[]): Promise<number> {
    keys.forEach(assertSafeKey);
    for (let i = 0; i < keys.length; i += 1000) {
      const Objects = keys.slice(i, i + 1000).map((Key) => ({ Key }));
      const res = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }));
      if (res.Errors?.length) throw new Error(`Deleting ${res.Errors.length} objects failed: ${res.Errors[0]?.Message ?? "unknown error"}`);
    }
    return keys.length;
  }

  signedUrl(key: string, ttlSeconds = AUDIO_URL_TTL_SECONDS): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}
