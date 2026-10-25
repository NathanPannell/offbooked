import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "./context.ts";
import { analyzeSpeech, shiftStretches, type Stretch } from "./render/trim.ts";

// Word timing for takes (see docs/api.md, LineAudio `speech` and `wordStartsMs`). The server knows
// where the voice is in each clip (its stretches of speech, from the clip's own levels) and when
// each word of the line starts (align/ctc.ts, from the recording alone, stored in ms of it). Both are
// served in ms of the clip as it plays: trimmed to the speech and normalized.

const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * How many word starts a line's take carries: its pieces as the web player tokenizes it
 * (`lineTokens` in web/src/player/words.ts). Each printed word of the character's is one, unless
 * it is a {note} or only markup (`_`, `*`); a [bracketed] direction (closed at the next "]", or
 * unclosed at the end of its printed line) counts each of its words; a printed stretch with no
 * letter or digit in it has none. Keep the two in step.
 */
export function pieceCount(text: string): number {
  return linePieces(text).length;
}

/** The pieces `pieceCount` counts, in order: their text, and whether the narrator says them (a [direction]) rather than the character. */
export function linePieces(text: string): { text: string; narrator: boolean }[] {
  const braces = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(/\{[^}]*\}/g)) for (let i = m.index; i < m.index + m[0].length; i++) braces[i] = true;
  // The character's own stretches and the narrator's [bracketed] ones.
  const regions: { from: number; to: number; narrator: boolean }[] = [];
  let at = 0;
  for (let open = text.indexOf("[", at); open !== -1; open = text.indexOf("[", at)) {
    if (open > at) regions.push({ from: at, to: open, narrator: false });
    const close = text.indexOf("]", open + 1);
    const lineEnd = text.indexOf("\n", open);
    const end = close !== -1 ? close + 1 : lineEnd !== -1 ? lineEnd : text.length;
    regions.push({ from: open, to: end, narrator: true });
    at = end;
  }
  if (at < text.length) regions.push({ from: at, to: text.length, narrator: false });

  // Pieces per (region, printed line), and whether that group has a word in it at all.
  const groups = new Map<string, { pieces: { text: string; narrator: boolean }[]; wordy: boolean }>();
  regions.forEach((region, r) => {
    let line = 0;
    for (let i = 0; i < region.from; i++) if (text[i] === "\n") line++;
    let i = region.from;
    while (i < region.to) {
      if (/\s/.test(text[i]!)) {
        if (text[i] === "\n") line++;
        i++;
        continue;
      }
      const start = i;
      const inBrace = !region.narrator && braces[i]!;
      while (i < region.to && !/\s/.test(text[i]!) && (region.narrator || braces[i] === inBrace)) i++;
      const raw = text.slice(start, i);
      const said = region.narrator ? raw.replace(/[[\]{}()]/g, " ") : inBrace ? "" : raw;
      const pieces = said.replace(/[_*]+/g, "").split(/\s+/).filter(Boolean);
      const key = `${r}:${line}`;
      const g = groups.get(key) ?? { pieces: [], wordy: false };
      g.pieces.push(...pieces.map((p) => ({ text: p, narrator: region.narrator })));
      g.wordy ||= pieces.some((p) => HAS_WORD.test(p));
      groups.set(key, g);
    }
  });
  return [...groups.values()].flatMap((g) => (g.wordy ? g.pieces : []));
}

/** Word starts in ms of the clip as served: moved by where the trim cut it, kept inside the clip. Undefined when they don't fit the line any more (it was edited). */
export function servedWordStarts(raw: readonly number[] | null, trimStartMs: number | null, durationMs: number, text: string): number[] | undefined {
  if (!raw?.length || trimStartMs === null || raw.length !== pieceCount(text)) return undefined;
  return raw.map((ms) => Math.max(0, Math.min(durationMs, ms - trimStartMs)));
}

/** Stretches as stored: flat [start, end, …] pairs. */
export const flattenStretches = (stretches: readonly Stretch[]): number[] => stretches.flatMap((s) => [Math.round(s.startMs), Math.round(s.endMs)]);

/** Stored stretches back as objects, kept inside the clip; undefined when there are none. */
export function servedSpeech(flat: readonly number[] | null, durationMs: number): Stretch[] | undefined {
  if (!flat?.length) return undefined;
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const startMs = Math.max(0, flat[i]!);
    const endMs = Math.min(durationMs, flat[i + 1]!);
    if (endMs > startMs) out.push({ startMs, endMs });
  }
  return out.length ? out : undefined;
}

// One analysis per take at a time and MAX_BACKFILLS in all. A take whose upload ffmpeg can't read
// isn't tried again; one that failed otherwise (storage, the database) is tried again by a request
// after BACKFILL_RETRY_MS. All in memory, and only ever driven by requests: no timers.
export const MAX_BACKFILLS = 2;
export const BACKFILL_RETRY_MS = 10 * 60_000;
const inflight = new Map<string, Promise<void>>();
const unreadable = new Set<string>();
const failedAt = new Map<string, number>();

/**
 * Works out the speech and the trim's cut for a take normalized before takes kept them: reads the
 * upload once, finds its speech as the normalization did, and stores both, so it is never done
 * again. `servedMs` is the normalized clip's length.
 */
export function backfillTiming(ctx: Ctx, take: { id: string; storageKey: string }, servedMs: number, now: number = Date.now()): Promise<void> {
  const running = inflight.get(take.id);
  if (running) return running;
  if (unreadable.has(take.id)) return Promise.resolve();
  const failed = failedAt.get(take.id);
  if (failed !== undefined && now - failed < BACKFILL_RETRY_MS) return Promise.resolve();
  // Only a few at once: the rest are left for a later request (nothing polls or waits for them).
  if (inflight.size >= MAX_BACKFILLS) return Promise.resolve();
  const job = (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-timing-"));
    try {
      const source = path.join(dir, `source${path.extname(take.storageKey)}`);
      await writeFile(source, await ctx.storage.get(take.storageKey));
      let analysis: Awaited<ReturnType<typeof analyzeSpeech>>;
      try {
        analysis = await analyzeSpeech(source);
      } catch (err) {
        // ffmpeg can't read the upload: that won't change, so it isn't tried again.
        unreadable.add(take.id);
        throw err;
      }
      const { bounds, stretches } = analysis;
      // The normalization cut here (render/ffmpeg.ts trimFilters), or kept the take whole.
      const cut = bounds && bounds.endMs - bounds.startMs >= 50 ? bounds.startMs : 0;
      const speech = flattenStretches(shiftStretches(stretches, cut, servedMs));
      await ctx.sql`update takes set speech_ms = ${speech}::int[], trim_start_ms = coalesce(trim_start_ms, ${Math.round(cut)}) where id = ${take.id}`;
      failedAt.delete(take.id);
    } catch (err) {
      // Storage or the database failing may pass: a request after the cooldown tries again.
      if (!unreadable.has(take.id)) failedAt.set(take.id, now);
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })().finally(() => inflight.delete(take.id));
  inflight.set(take.id, job);
  return job;
}
