import type { AudioSource } from "../api/types";

// Line timing helpers for the run-through player.

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The words an actor says: the line without its [bracketed] directions, as the TTS voice reads it. */
export function spokenText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\[[^\n]*/g, " ") // an unclosed bracket runs to the end of its line
    .replace(/\{[^}]*\}/g, " ");
}

/** A typical stage delivery: about 150 words a minute. */
export const STAGE_WORDS_PER_SECOND = 2.5;
export const MIN_PAUSE_MS = 1000;
/** A recorded line gets its own length plus this much (or RECORDED_MIN_EXTRA_MS, if more). */
export const RECORDED_EXTRA = 0.15;
export const RECORDED_MIN_EXTRA_MS = 500;

/**
 * How long to pause while the listener says one of their lines ("Pause, then read"). A recorded
 * line takes as long as its (trimmed) take plus a little; anything else is timed from its spoken
 * words at a stage speaking rate. Never shorter than MIN_PAUSE_MS. Playback speed doesn't scale it.
 */
export function myLinePauseMs(line: { text: string; recordedMs?: number | null }): number {
  if (line.recordedMs && line.recordedMs > 0) {
    const extra = Math.max(line.recordedMs * RECORDED_EXTRA, RECORDED_MIN_EXTRA_MS);
    return Math.max(MIN_PAUSE_MS, Math.round(line.recordedMs + extra));
  }
  const words = wordCount(spokenText(line.text));
  return Math.max(MIN_PAUSE_MS, Math.round((words / STAGE_WORDS_PER_SECOND) * 1000));
}

/** The small tag shown beside a line when listening, or null for a recording (the cast's or the director's). */
export function audioSourceTag(source: AudioSource): string | null {
  switch (source) {
    case "actor":
    case "director":
      return null;
    case "tts":
      return "TTS";
    case "none":
      return "silent";
  }
}
