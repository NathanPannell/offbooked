import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";

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

export function buildApp(opts: { revision?: string; probeFfmpeg?: () => Promise<string | null> } = {}) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const probe = opts.probeFfmpeg ?? ffmpegVersion;

  app.get("/health", async (_req, reply) => {
    const ffmpeg = await probe();
    reply.code(ffmpeg ? 200 : 503);
    return { ok: Boolean(ffmpeg), service: "castpals-api", revision: opts.revision ?? "dev", ffmpeg };
  });

  return app;
}
