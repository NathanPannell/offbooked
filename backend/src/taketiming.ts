import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "./context.ts";
import { analyzeSpeech, shiftStretches, type Stretch } from "./render/trim.ts";

// Word timing for takes (see docs/api.md, LineAudio `speech` and `wordStartsMs`). The server knows
// where the voice is in each clip (its stretches of speech, from the clip's own levels); the app
// knows when each word started, from following the take while it recorded, and sends that with
// the upload in ms of the recording. Both are served in ms of the clip as it plays: trimmed to the
// speech and normalized.

/** At most this many word starts are kept for a take (a very long speech). */
export const MAX_WORD_STARTS = 2000;

const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * How many word starts a line's take carries: its pieces as the web player tokenizes it
 * (`lineTokens` in web/src/player/words.ts). Each printed word of the character's is one, unless
 * it is a {note} or only markup (`_`, `*`); a [bracketed] direction (closed at the next "]", or
 * unclosed at the end of its printed line) counts each of its words; a printed stretch with no
 * letter or digit in it has none. Keep the two in step.
 */
export function pieceCount(text: string): number {
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
  const groups = new Map<string, { pieces: number; wordy: boolean }>();
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
      const g = groups.get(key) ?? { pieces: 0, wordy: false };
      g.pieces += pieces.length;
      g.wordy ||= pieces.some((p) => HAS_WORD.test(p));
      groups.set(key, g);
    }
  });
  let count = 0;
  for (const g of groups.values()) if (g.wordy) count += g.pieces;
  return count;
}

/**
 * The X-Word-Starts header of a take upload: comma-separated ms of the recording, one per spoken
 * word of the line, never going back. Null when it is missing, malformed, or doesn't fit the line
 * (the count is wrong, or a start is past the end of the recording): the take is kept either way.
 */
export function parseWordStarts(header: unknown, text: string, durationMs: number): number[] | null {
  if (typeof header !== "string" || !header.trim()) return null;
  const parts = header.split(",");
  if (parts.length > MAX_WORD_STARTS) return null;
  const starts: number[] = [];
  for (const part of parts) {
    if (!/^\s*\d{1,9}\s*$/.test(part)) return null;
    const ms = Number(part);
    if (ms > durationMs + 1000 || (starts.length && ms < starts[starts.length - 1]!)) return null;
    starts.push(ms);
  }
  return starts.length === pieceCount(text) ? starts : null;
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

// One analysis per take at a time, and a take whose upload can't be read isn't tried again.
const inflight = new Map<string, Promise<void>>();
const unreadable = new Set<string>();

/**
 * Works out the speech and the trim's cut for a take normalized before takes kept them: reads the
 * upload once, finds its speech as the normalization did, and stores both, so it is never done
 * again. `servedMs` is the normalized clip's length.
 */
export function backfillTiming(ctx: Ctx, take: { id: string; storageKey: string }, servedMs: number): Promise<void> {
  if (unreadable.has(take.id)) return Promise.resolve();
  let running = inflight.get(take.id);
  if (!running) {
    running = (async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "offbooked-timing-"));
      try {
        const source = path.join(dir, `source${path.extname(take.storageKey)}`);
        await writeFile(source, await ctx.storage.get(take.storageKey));
        const { bounds, stretches } = await analyzeSpeech(source);
        // The normalization cut here (render/ffmpeg.ts trimFilters), or kept the take whole.
        const cut = bounds && bounds.endMs - bounds.startMs >= 50 ? bounds.startMs : 0;
        const speech = flattenStretches(shiftStretches(stretches, cut, servedMs));
        await ctx.sql`update takes set speech_ms = ${speech}::int[], trim_start_ms = coalesce(trim_start_ms, ${Math.round(cut)}) where id = ${take.id}`;
      } catch (err) {
        unreadable.add(take.id);
        throw err;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })().finally(() => inflight.delete(take.id));
    inflight.set(take.id, running);
  }
  return running;
}
