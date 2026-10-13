import { GetObjectCommand, HeadObjectCommand, NotFound, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AUDIO_URL_TTL_SECONDS, assertSafeKey, type Storage } from "./storage.ts";

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

  signedUrl(key: string, ttlSeconds = AUDIO_URL_TTL_SECONDS): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}
