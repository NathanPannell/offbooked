import type { AudioSource, TimingEntry } from "../api/types";

// Pure navigation over the render's timing map. All times are milliseconds into the render.

export interface Segment extends TimingEntry {
  index: number;
}

export function buildSegments(timing: TimingEntry[]): Segment[] {
  return [...timing].sort((a, b) => a.startMs - b.startMs).map((t, index) => ({ ...t, index }));
}

/** The segment playing at `ms`: the last one that has started. Stays on a line through the pause after it. */
export function segmentIndexAt(segments: Segment[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Where "next line" goes, or null at the last line. */
export function nextLineStart(segments: Segment[], ms: number): number | null {
  const next = segments[segmentIndexAt(segments, ms) + 1];
  return next ? next.startMs : null;
}

/** Restarts the current line, or goes back one line if the current line only just started. */
export function previousLineStart(segments: Segment[], ms: number, restartAfterMs = 1500): number {
  if (segments.length === 0) return 0;
  const current = segmentIndexAt(segments, ms);
  if (current < 0) return segments[0].startMs;
  if (ms - segments[current].startMs > restartAfterMs) return segments[current].startMs;
  return segments[Math.max(0, current - 1)].startMs;
}

export interface AbRange {
  startMs: number;
  endMs: number;
}

/** A–B repeat over whole lines, whichever order the two lines were tapped in. */
export function abRange(segments: Segment[], a: number, b: number): AbRange {
  const first = segments[Math.min(a, b)];
  const last = segments[Math.max(a, b)];
  return { startMs: first.startMs, endMs: last.endMs };
}

/** Where to jump to keep looping, or null to keep playing. */
export function abLoopTarget(range: AbRange, ms: number): number | null {
  return ms >= range.endMs ? range.startMs : null;
}

export const GAP_MULTIPLIER_MIN = 1;
export const GAP_MULTIPLIER_MAX = 2;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** How long to wait while the actor speaks their line: from its word count, scaled by their setting. */
export function gapMs(text: string, multiplier: number): number {
  const m = Math.min(GAP_MULTIPLIER_MAX, Math.max(GAP_MULTIPLIER_MIN, multiplier));
  const auto = Math.min(15_000, Math.max(1500, wordCount(text) * 400 + 800));
  return Math.round(auto * m);
}

/**
 * In my-part mode, the actor's own segment that playback has reached (or is about to,
 * within `lookaheadMs`), so the player can pause there and hold a speaking gap.
 */
export function myGapSegmentAt(
  segments: Segment[],
  mine: Set<string>,
  ms: number,
  lookaheadMs = 40,
): Segment | null {
  const index = segmentIndexAt(segments, ms + lookaheadMs);
  const segment = segments[index];
  if (!segment || !mine.has(segment.lineId)) return null;
  // After a gap, playback resumes from the segment's end, which must not trigger it again.
  return ms < segment.endMs - 1 ? segment : null;
}

/** Where a line's audio comes from. Older servers only say whether it was recorded. */
export function audioSourceOf(entry: Pick<TimingEntry, "recorded" | "source"> | undefined): AudioSource {
  if (!entry) return "none";
  return entry.source ?? (entry.recorded ? "actor" : "none");
}

/** The small tag shown beside a line in the run-through, or null for the cast's own recording. */
export function audioSourceTag(source: AudioSource): string | null {
  switch (source) {
    case "actor":
      return null;
    case "standin":
      return "stand-in";
    case "tts":
      return "TTS";
    case "none":
      return "silent";
  }
}
