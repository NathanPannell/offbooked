import { createHash } from "node:crypto";

export const RENDER_SETTINGS = {
  version: 1,
  sampleRate: 48_000,
  gapMs: 350,
  sectionGapMs: 1200,
  msPerWord: 380,
  minPlaceholderMs: 1200,
  maxPlaceholderMs: 8000,
  loudnessI: -16,
} as const;

export interface PlanLine {
  lineId: string;
  sectionId: string;
  text: string;
  takeId: string | null;
}

export type Segment = { kind: "take"; takeId: string; samples: number } | { kind: "silence"; samples: number };

export interface TimingEntry {
  lineId: string;
  startMs: number;
  endMs: number;
  recorded: boolean;
}

const S = RENDER_SETTINGS;
const msToSamples = (ms: number) => Math.round((ms * S.sampleRate) / 1000);
const samplesToMs = (samples: number) => Math.round((samples * 1000) / S.sampleRate);

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function placeholderMs(text: string): number {
  return Math.min(S.maxPlaceholderMs, Math.max(S.minPlaceholderMs, wordCount(text) * S.msPerWord));
}

// Identifies a render's inputs: line order, section breaks, takes, placeholder lengths and settings.
export function contentHash(lines: PlanLine[]): string {
  const h = createHash("sha256").update(JSON.stringify(S));
  for (const l of lines) h.update(`\n${l.lineId}|${l.sectionId}|${l.takeId ?? `-${placeholderMs(l.text)}`}`);
  return h.digest("hex");
}

// Lays dialogue lines end to end with gaps, counting in samples so the timing map never drifts
// from the audio. takeSamples holds each normalized take's measured length.
export function planRender(lines: PlanLine[], takeSamples: Map<string, number>): { segments: Segment[]; timing: TimingEntry[]; totalSamples: number } {
  const segments: Segment[] = [];
  const timing: TimingEntry[] = [];
  let cursor = 0;
  const silence = (samples: number) => {
    if (samples <= 0) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "silence") last.samples += samples;
    else segments.push({ kind: "silence", samples });
    cursor += samples;
  };

  lines.forEach((line, i) => {
    if (i > 0) silence(msToSamples(line.sectionId === lines[i - 1]!.sectionId ? S.gapMs : S.sectionGapMs));
    const start = cursor;
    const samples = line.takeId ? takeSamples.get(line.takeId) : undefined;
    if (line.takeId && samples !== undefined && samples > 0) {
      segments.push({ kind: "take", takeId: line.takeId, samples });
      cursor += samples;
    } else {
      silence(msToSamples(placeholderMs(line.text)));
    }
    timing.push({ lineId: line.lineId, startMs: samplesToMs(start), endMs: samplesToMs(cursor), recorded: Boolean(line.takeId && samples) });
  });
  return { segments, timing, totalSamples: cursor };
}
