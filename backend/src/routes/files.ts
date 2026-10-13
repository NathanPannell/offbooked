import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Ctx } from "../context.ts";
import { HttpError, notFound } from "../errors.ts";
import { LocalStorage } from "../storage/local.ts";
import { contentTypeForKey } from "../storage/storage.ts";

// Parses a single "bytes=a-b" range. Multi-range requests are answered with the whole file.
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return header.includes(",") ? null : "invalid";
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

export function fileRoutes(app: FastifyInstance, ctx: Ctx) {
  // Signed URLs for the local storage driver. S3 serves its own presigned URLs.
  if (ctx.storage instanceof LocalStorage) {
    const storage = ctx.storage;
    app.get("/api/files/*", async (req, reply) => {
      const key = (req.params as { "*": string })["*"];
      const q = req.query as { exp?: string; sig?: string };
      if (!q.sig || !storage.verify(key, Number(q.exp), q.sig)) throw new HttpError(403, "forbidden", "This link has expired.");
      const file = storage.pathFor(key);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw notFound("File not found.");
      reply.header("Content-Type", contentTypeForKey(key));
      reply.header("Accept-Ranges", "bytes");
      reply.header("Cross-Origin-Resource-Policy", "cross-origin");
      reply.header("Cache-Control", "private, max-age=3600");
      const range = parseRange(req.headers.range, info.size);
      if (range === "invalid") {
        reply.header("Content-Range", `bytes */${info.size}`);
        throw new HttpError(416, "range_not_satisfiable", "Requested range not satisfiable.");
      }
      if (range) {
        reply.code(206);
        reply.header("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
        reply.header("Content-Length", range.end - range.start + 1);
        return reply.send(createReadStream(file, { start: range.start, end: range.end }));
      }
      reply.header("Content-Length", info.size);
      return reply.send(createReadStream(file));
    });
  }
}
