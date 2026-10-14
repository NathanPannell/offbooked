import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "./app.ts";

process.env.NODE_ENV = "test";

test("health is ok when ffmpeg is present", async () => {
  const app = buildApp({ revision: "abc123", probeFfmpeg: async () => "ffmpeg version 7.1" });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, service: "offbooked-api", revision: "abc123", ffmpeg: "ffmpeg version 7.1", tts: null });
});

test("health fails when ffmpeg is missing", async () => {
  const app = buildApp({ probeFfmpeg: async () => null });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().ok, false);
});
