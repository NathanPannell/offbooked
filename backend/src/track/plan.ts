import type { ResolvedLineAudio } from "../linestream.ts";
import { RENDER_SETTINGS, wordCount } from "../render/plan.ts";
import type { SpokenSegment } from "../tts/service.ts";
import type { Stretch } from "../render/trim.ts";

// Lays out a listen track: a stretch of the listen-through as one file, in the order and with the
// timing the line-by-line player uses (web/src/player/queue.ts, engine.ts, timing.ts), so the two
// sound the same and the player can move between them. Counts in samples so the items never drift
// from the audio.

const RATE = RENDER_SETTINGS.sampleRate;
const msToSamples = (ms: number) => Math.max(0, Math.round((ms * RATE) / 1000));
const samplesToMs = (samples: number) => Math.round((samples * 1000) / RATE);

/** What happens on the listener's own lines, as in the player: played, a silence, or a silence then the line. */
export type MyLineMode = "read" | "skip" | "pause";
export const MY_LINE_MODES: readonly MyLineMode[] = ["read", "skip", "pause"];

export interface TrackLine {
  lineId: string;
  sectionId: string;
  text: string;
  audio: ResolvedLineAudio;
}

/**
 * One line's place in the track. "line" is its audio (or the silence it keeps when it has none);
 * "speak" is the silence while the listener says their own line. The time between items is the
 * pause between lines. Line items carry the clip's word timing, as the line-by-line answer does.
 */
export interface TrackItem {
  lineId: string;
  kind: "line" | "speak";
  startMs: number;
  durationMs: number;
  source?: ResolvedLineAudio["source"];
  segments?: SpokenSegment[];
  speech?: Stretch[];
  wordStartsMs?: number[];
}

/** What the encoder joins, in order: a clip's .m4a cut or padded to `samples`, or silence. */
export type TrackPiece = { kind: "clip"; key: string; samples: number } | { kind: "silence"; samples: number };

export interface TrackPlan {
  items: TrackItem[];
  pieces: TrackPiece[];
  totalSamples: number;
}

// Keep in step with web/src/player/timing.ts (myLinePauseMs, spokenText).
const STAGE_WORDS_PER_SECOND = 2.5;
const MIN_PAUSE_MS = 1000;
const RECORDED_EXTRA = 0.15;
const RECORDED_MIN_EXTRA_MS = 500;

export function spokenText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\[[^\n]*/g, " ")
    .replace(/\{[^}]*\}/g, " ");
}

/** How long the listener gets to say their own line: a recorded take's length plus a little, else its words at a stage pace. */
export function myLinePauseMs(text: string, recordedMs: number | null): number {
  if (recordedMs && recordedMs > 0) {
    const extra = Math.max(recordedMs * RECORDED_EXTRA, RECORDED_MIN_EXTRA_MS);
    return Math.max(MIN_PAUSE_MS, Math.round(recordedMs + extra));
  }
  return Math.max(MIN_PAUSE_MS, Math.round((wordCount(spokenText(text)) / STAGE_WORDS_PER_SECOND) * 1000));
}

const recorded = (source: string) => source === "actor" || source === "director";

export function planTrack(lines: TrackLine[], mine: ReadonlySet<string>, mode: MyLineMode): TrackPlan {
  const items: TrackItem[] = [];
  const pieces: TrackPiece[] = [];
  let cursor = 0;
  const silence = (samples: number) => {
    if (samples <= 0) return;
    const last = pieces[pieces.length - 1];
    if (last?.kind === "silence") last.samples += samples;
    else pieces.push({ kind: "silence", samples });
    cursor += samples;
  };

  lines.forEach((line, i) => {
    const before = lines[i - 1];
    if (before) silence(msToSamples(before.sectionId === line.sectionId ? RENDER_SETTINGS.gapMs : RENDER_SETTINGS.sectionGapMs));
    const { audio } = line;
    const own = mine.has(line.lineId);
    if (own && mode !== "read") {
      const start = cursor;
      silence(msToSamples(myLinePauseMs(line.text, recorded(audio.source) ? audio.durationMs : null)));
      items.push({ lineId: line.lineId, kind: "speak", startMs: samplesToMs(start), durationMs: samplesToMs(cursor - start) });
      if (mode === "skip") return;
    }
    const start = cursor;
    const samples = msToSamples(audio.durationMs);
    if (audio.audioKey && samples > 0) {
      pieces.push({ kind: "clip", key: audio.audioKey, samples });
      cursor += samples;
    } else silence(samples);
    // A silent stand-in has none of a clip's timings.
    const timings = audio.audioKey
      ? {
          ...(audio.segments?.length ? { segments: audio.segments } : {}),
          ...(audio.speech?.length ? { speech: audio.speech } : {}),
          ...(audio.wordStartsMs?.length ? { wordStartsMs: audio.wordStartsMs } : {}),
        }
      : {};
    items.push({ lineId: line.lineId, kind: "line", startMs: samplesToMs(start), durationMs: samplesToMs(cursor - start), source: audio.source, ...timings });
  });
  return { items, pieces, totalSamples: cursor };
}
