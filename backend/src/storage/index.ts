import type { Config } from "../config.ts";
import { LocalStorage } from "./local.ts";
import { S3Storage } from "./s3.ts";
import type { Storage } from "./storage.ts";

export function createStorage(config: Config): Storage {
  if (config.storage.driver === "s3") return new S3Storage(config.storage);
  return new LocalStorage({ dir: config.storage.dir, apiUrl: config.apiUrl, secret: config.sessionSecret });
}
