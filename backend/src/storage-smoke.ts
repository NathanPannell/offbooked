// One-off check that the configured storage driver can write, read back, and serve a ranged signed URL.
// Run with the production service variables: `railway run -- node src/storage-smoke.ts`.
import { createStorage } from "./storage/index.ts";
import { loadConfig } from "./config.ts";

const storage = createStorage(loadConfig());
const key = `smoke/${Date.now()}.txt`;
const body = Buffer.from("offbooked storage smoke test");
await storage.put(key, body, "text/plain");
const url = await storage.signedUrl(key, 300);
const res = await fetch(url, { headers: { Range: "bytes=0-8" } });
const text = await res.text();
console.log(JSON.stringify({ driver: process.env.STORAGE_DRIVER, status: res.status, contentRange: res.headers.get("content-range"), body: text }));
