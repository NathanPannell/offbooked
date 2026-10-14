import type { Ctx } from "../context.ts";
import { contentHash, type TimingEntry } from "./plan.ts";
import { planInputs } from "./queue.ts";

interface RenderRow {
  status: "queued" | "rendering" | "ready" | "failed";
  storageKey: string | null;
  durationMs: number | null;
  timing: TimingEntry[] | null;
  contentHash: string | null;
  finishedAt: Date | null;
}

// Status comes from the newest job; audio and timing from the newest finished render, so the
// last good run-through keeps playing while a new one builds. Stale means the inputs changed: a
// new take or stand-in, an edited line, or a different TTS voice or engine.
export async function renderView(ctx: Ctx, productionId: string) {
  const [latest] = await ctx.sql<RenderRow[]>`
    select status, storage_key, duration_ms, timing, content_hash, finished_at from renders
    where production_id = ${productionId} order by created_at desc limit 1`;
  const [ready] = await ctx.sql<RenderRow[]>`
    select status, storage_key, duration_ms, timing, content_hash, finished_at from renders
    where production_id = ${productionId} and status = 'ready' order by finished_at desc limit 1`;
  if (!latest) return { status: "none" as const, audioUrl: null, durationMs: null, createdAt: null, stale: false, timing: [] };
  const current = ready ? contentHash((await planInputs(ctx, productionId)).lines) : null;
  return {
    status: latest.status,
    audioUrl: ready?.storageKey ? await ctx.storage.signedUrl(ready.storageKey) : null,
    durationMs: ready?.durationMs ?? null,
    createdAt: ready?.finishedAt ? new Date(ready.finishedAt).toISOString() : null,
    stale: Boolean(ready && current !== ready.contentHash),
    // Renders from before TTS have no source on their timing entries.
    timing: (ready?.timing ?? []).map((e) => ({ ...e, source: e.source ?? (e.recorded ? "actor" : "none") })),
  };
}
