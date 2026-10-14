import { createHash } from "node:crypto";

export const RENDER_SETTINGS = {
  version: 2,
  sampleRate: 48_000,
  gapMs: 350,
  sectionGapMs: 1200,
  msPerWord: 380,
  minPlaceholderMs: 1200,
  maxPlaceholderMs: 8000,
  loudnessI: -16,
} as const;

export type AudioSource = "actor" | "standin" | "tts" | "none";

export interface PlanLine {
  lineId: string;
  sectionId: string;
  text: string;
  takeId: string | null; // the current take: the newest one, by the actor or a stand-in
  takeSource?: "actor" | "standin" | null;
  ttsHash?: string | null; // synthesized clip used when there is no take
}

export type Segment =
  | { kind: "take"; takeId: string; samples: number }
  | { kind: "tts"; hash: string; samples: number }
  | { kind: "silence"; samples: number };

export interface TimingEntry {
  lineId: string;
  startMs: number;
  endMs: number;
  recorded: boolean; // true for an actor or stand-in take
  source: AudioSource;
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

// Identifies a render's inputs: line order, section breaks, takes, TTS clips, placeholder lengths
// and settings. A new take or stand-in, or any change to a synthesized line, changes it.
export function contentHash(lines: PlanLine[]): string {
  const h = createHash("sha256").update(JSON.stringify(S));
  for (const l of lines) h.update(`\n${l.lineId}|${l.sectionId}|${l.takeId ?? (l.ttsHash ? `tts:${l.ttsHash}` : `-${placeholderMs(l.text)}`)}`);
  return h.digest("hex");
}

// Lays dialogue lines end to end with gaps, counting in samples so the timing map never drifts
// from the audio. takeSamples and ttsSamples hold each normalized clip's measured length.
// Each line uses its take, else its synthesized clip, else a silence of placeholder length.
export function planRender(
  lines: PlanLine[],
  takeSamples: Map<string, number>,
  ttsSamples: Map<string, number> = new Map(),
): { segments: Segment[]; timing: TimingEntry[]; totalSamples: number } {
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
    const tts = line.ttsHash ? ttsSamples.get(line.ttsHash) : undefined;
    let source: AudioSource;
    if (line.takeId && samples !== undefined && samples > 0) {
      segments.push({ kind: "take", takeId: line.takeId, samples });
      cursor += samples;
      source = line.takeSource ?? "actor";
    } else if (line.ttsHash && tts !== undefined && tts > 0) {
      segments.push({ kind: "tts", hash: line.ttsHash, samples: tts });
      cursor += tts;
      source = "tts";
    } else {
      silence(msToSamples(placeholderMs(line.text)));
      source = "none";
    }
    timing.push({ lineId: line.lineId, startMs: samplesToMs(start), endMs: samplesToMs(cursor), recorded: source === "actor" || source === "standin", source });
  });
  return { segments, timing, totalSamples: cursor };
}
