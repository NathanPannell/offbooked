// Where Listen back of a take just recorded should stop. The live take feeds it the take's voiced
// stretches (from the mic level) and when the end of the line was heard. Nothing here is sent to
// the server: it finds each take's words in the recording itself. All pure, except that
// `addVoiced` grows its list in place (it runs every 20 ms of a take).

/** Voiced time in a take, in ms of the take. */
export interface Stretch {
  startMs: number;
  endMs: number;
}

/** A gap shorter than this inside speech is the space between two words, not a pause. */
export const STRETCH_GAP_MS = 150;

/** Adds voiced time [startMs, endMs] to the stretches, joining it to the last one across a short gap. */
export function addVoiced(stretches: Stretch[], startMs: number, endMs: number, gapMs = STRETCH_GAP_MS): Stretch[] {
  if (endMs <= startMs) return stretches;
  const last = stretches[stretches.length - 1];
  if (last && startMs <= last.endMs + gapMs) {
    if (endMs > last.endMs) stretches[stretches.length - 1] = { startMs: Math.min(last.startMs, startMs), endMs };
    return stretches;
  }
  stretches.push({ startMs, endMs });
  return stretches;
}

/** What the live take keeps for Listen back, in ms of the take. */
export interface TakeTiming {
  lineId: string;
  /** Where the live capture's first sample sits in the recording. */
  offsetMs: number;
  stretches: Stretch[];
  /** The end of the audio of the pass that first heard the end of the line, or null if none did. */
  lineEndMs: number | null;
}

/** Voice kept after the line's last stretch when a take just recorded plays back on the phone. */
export const LISTEN_TAIL_MS = 300;

/**
 * Where Listen back of a take just recorded stops, in ms of the recording: just after the stretch
 * of voice the end of the line was heard in, so it doesn't play the pause that ended the take (the
 * server cuts its own copy to the voice; this is the raw recording, still on the phone). Null when
 * the end of the line wasn't heard or there's nothing to leave out: then it plays to the end.
 */
export function listenEndMs(timing: TakeTiming | null, lineId: string, durationMs: number): number | null {
  if (!timing || timing.lineId !== lineId || timing.lineEndMs === null) return null;
  const heardAt = timing.lineEndMs;
  const stretch = timing.stretches.filter((s) => s.startMs < heardAt).pop();
  if (!stretch) return null;
  const end = Math.round(stretch.endMs + timing.offsetMs + LISTEN_TAIL_MS);
  return end < durationMs - 100 ? end : null;
}
