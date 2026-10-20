import { execFile } from "node:child_process";
import { promisify } from "node:util";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyError } from "fastify";
import type { Ctx } from "./context.ts";
import { HttpError } from "./errors.ts";
import { actorRoutes } from "./routes/actor.ts";
import { authRoutes } from "./routes/auth.ts";
import { castRoutes } from "./routes/cast.ts";
import { joinRoutes } from "./routes/join.ts";
import { emailRoutes } from "./routes/email.ts";
import { fileRoutes } from "./routes/files.ts";
import { MAX_PDF_BYTES, productionRoutes } from "./routes/productions.ts";
import { runthroughRoutes } from "./routes/runthrough.ts";
import { scriptRoutes } from "./routes/script.ts";
import { studioRoutes } from "./routes/studio.ts";
import { MAX_TAKE_BYTES } from "./takes.ts";

const run = promisify(execFile);

// The render pipeline (#18) needs ffmpeg in the image; /health reports it so a bad image fails the deploy check.
export async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-version"]);
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

// "https://*.vercel.app" allows one DNS label in place of the star.
export function originMatcher(patterns: string[]): (origin: string) => boolean {
  const regexes = patterns.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+")}$`, "i"));
  return (origin) => regexes.some((re) => re.test(origin));
}

const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

export function buildApp(opts: { revision?: string; probeFfmpeg?: () => Promise<string | null>; ctx?: Ctx } = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test", trustProxy: true });
  const probe = opts.probeFfmpeg ?? ffmpegVersion;

  // TTS is optional: without it unrecorded lines render as silence, so it never fails the check.
  app.get("/health", async (_req, reply) => {
    const [ffmpeg, tts] = await Promise.all([probe(), opts.ctx?.tts?.engine() ?? null]);
    reply.code(ffmpeg ? 200 : 503);
    return { ok: Boolean(ffmpeg), service: "offbooked-api", revision: opts.revision ?? "dev", ffmpeg, tts };
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message }, ...err.extra });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, "request failed");
    const message = status === 413 ? "That upload is too large." : status === 500 ? "Something went wrong on our side. Try again." : err.message;
    return reply.code(status).send({ error: { code: STATUS_CODES[status] ?? "error", message } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Not found." } }));

  const ctx = opts.ctx;
  if (!ctx) return app;

  const allowed = originMatcher(ctx.config.corsOrigins);
  app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed(origin)),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Take-Id", "X-Duration-Ms", "Range"],
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
    maxAge: 600,
  });
  app.register(multipart, { limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 5 } });

  // An empty JSON body (e.g. a bare POST with Content-Type set) is treated as {}.
  const jsonParser = app.getDefaultJsonParser("error", "ignore");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, raw, done) => {
    if (!String(raw).trim()) return done(null, {});
    jsonParser(req, raw as string, done);
  });
  // HTML forms in the email pages (verify's Confirm button, one-click List-Unsubscribe).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, raw, done) =>
    done(null, Object.fromEntries(new URLSearchParams(raw as string))),
  );
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: MAX_TAKE_BYTES }, (_req, raw, done) => done(null, raw));

  // API responses depend on the Authorization header, not the URL, so browsers must never reuse them.
  // Signed file URLs set their own caching.
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/") && !req.url.startsWith("/api/files/") && !reply.hasHeader("cache-control")) {
      reply.header("Cache-Control", "no-store");
      reply.header("Vary", "Authorization, Origin");
    }
  });

  // Retention catch-up rides on real requests, never on a timer or a health check (retention.ts).
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/api/")) ctx.retention.touch();
  });

  app.register(async (api) => {
    authRoutes(api, ctx);
    productionRoutes(api, ctx);
    scriptRoutes(api, ctx);
    castRoutes(api, ctx);
    joinRoutes(api, ctx);
    actorRoutes(api, ctx);
    studioRoutes(api, ctx);
    runthroughRoutes(api, ctx);
    fileRoutes(api, ctx);
    emailRoutes(api, ctx);
  });
  return app;
}
