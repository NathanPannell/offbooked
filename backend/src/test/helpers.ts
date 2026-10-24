import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createCtx, type Ctx } from "../context.ts";
import { createSql, migrate } from "../db.ts";
import { LogMailer } from "../email/mailer.ts";
import { silentLog } from "../log.ts";
import type { Labeler } from "../parse/label.ts";
import type { EnsembleInferrer } from "../shared.ts";
import type { Synthesizer } from "../tts/piper.ts";

process.env.NODE_ENV = "test";

// DB tests need DATABASE_URL (backend/.env locally). Without it they are skipped, not failed,
// except in CI, where skipping them would let the migrations and the idle-worker test go unchecked.
if (process.env.CI && !process.env.DATABASE_URL) throw new Error("CI runs the DB tests: set DATABASE_URL to a throwaway Postgres");
export const dbSkip = process.env.DATABASE_URL ? false : "DATABASE_URL is not set";

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  ctx: Ctx;
  mailer: LogMailer;
  close: () => Promise<void>;
}

// Each test file gets its own throwaway schema, migrated from scratch and dropped afterwards.
// TTS is off unless a test passes a synthesizer (see FakeSynthesizer in ./tts.ts).
export async function createTestApp(
  opts: { labeler?: Labeler | null; ensemble?: EnsembleInferrer | null; env?: Record<string, string>; synthesizer?: Synthesizer | null } = {},
): Promise<TestApp> {
  const url = process.env.DATABASE_URL!;
  const schema = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = createSql(url, { max: 1 });
  await admin.unsafe(`create schema ${schema}`);
  const sql = createSql(url, { schema, max: 4 });
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-test-"));
  try {
    await migrate(sql);
  } catch (err) {
    await admin.unsafe(`drop schema ${schema} cascade`);
    throw err;
  }
  const config = loadConfig({
    DATABASE_URL: url,
    SESSION_SECRET: "test-session-secret",
    INVITE_TOKEN_SECRET: "test-invite-secret",
    APP_URL: "https://app.test",
    API_URL: "http://api.test",
    CORS_ORIGINS: "https://app.test,https://*.vercel.app",
    EMAIL_DRIVER: "log",
    STORAGE_DRIVER: "local",
    STORAGE_DIR: dir,
    RENDER_DEBOUNCE_MS: "0",
    // Tests that upload takes don't need ffmpeg behind each one; the ones about it turn it on.
    NORMALIZE_ON_UPLOAD: "0",
    ...opts.env,
  });
  const mailer = new LogMailer(silentLog);
  const ctx = createCtx(config, sql, silentLog, {
    mailer,
    labeler: opts.labeler ?? null,
    ensemble: opts.ensemble ?? null,
    synthesizer: opts.synthesizer ?? null,
  });
  const app = buildApp({ ctx, probeFfmpeg: async () => "ffmpeg test" });
  await app.ready();
  return {
    app,
    ctx,
    mailer,
    close: async () => {
      await app.close();
      await ctx.jobs.idle();
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end({ timeout: 5 });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function signIn(t: TestApp, email: string): Promise<string> {
  const req = await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email } });
  const token = new URL(req.json().devLink).searchParams.get("token");
  const res = await t.app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
  return res.json().sessionToken;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const invite = (url: string) => ({ authorization: `Invite ${url.split("/i/")[1]}` });

// A production with the given script parsed (heuristic parser unless the app has a chunk parser).
export async function productionWithScript(t: TestApp, session: string, text: string, title = "Test show") {
  const created = await t.app.inject({ method: "POST", url: "/api/productions", headers: bearer(session), payload: { title } });
  const id = created.json().production.id as string;
  await t.app.inject({ method: "POST", url: `/api/productions/${id}/script`, headers: bearer(session), payload: { text } });
  await t.ctx.jobs.idle();
  const script = (await t.app.inject({ method: "GET", url: `/api/productions/${id}/script`, headers: bearer(session) })).json();
  return { id, script };
}
