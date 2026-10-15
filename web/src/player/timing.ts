import type { AudioSource } from "../api/types";

// Line timing helpers for the run-through player.

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
