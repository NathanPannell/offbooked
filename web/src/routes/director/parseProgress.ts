import type { ParseProgress } from "../../api/types";

export const PARSE_STAGES = ["Reading the file", "Finding scenes and speeches", "Saving your script"] as const;

export interface ProgressView {
  /** 0 reading, 1 labelling, 2 saving. */
  stage: 0 | 1 | 2;
  /** 0..1 for the bar, or null while the size isn't known yet. */
  fraction: number | null;
  /** "97 pages", "2,340 of 5,190 lines", "14 scenes", "612 speeches found". */
  counts: string[];
}

function num(n: number, locale?: string): string {
  return n.toLocaleString(locale);
}

function count(n: number, one: string, many: string, locale?: string): string {
  return `${num(n, locale)} ${n === 1 ? one : many}`;
}

/** Turns the server's parse progress into a stage, a bar position and live counts. */
export function describeProgress(p: ParseProgress | null | undefined, locale?: string): ProgressView {
  const stage = p?.stage === "saving" ? 2 : p?.stage === "labelling" || (p?.linesTotal ?? 0) > 0 ? 1 : 0;
  const total = p?.linesTotal ?? 0;
  const done = Math.min(total, Math.max(0, p?.linesDone ?? 0));
  let fraction: number | null = null;
  if (stage === 2) fraction = 1;
  else if (stage === 1 && total > 0) fraction = done / total;
  else if (stage === 1 && (p?.chunksTotal ?? 0) > 0) fraction = Math.min(1, (p!.chunksDone ?? 0) / p!.chunksTotal!);

  const counts: string[] = [];
  if (p?.pages) counts.push(count(p.pages, "page", "pages", locale));
  if (total > 0) {
    counts.push(stage === 2 ? count(total, "line", "lines", locale) : `${num(done, locale)} of ${count(total, "line", "lines", locale)}`);
  }
  if (p?.scenes) counts.push(count(p.scenes, "scene", "scenes", locale));
  if (p?.speeches) counts.push(`${count(p.speeches, "speech", "speeches", locale)} found`);
  return { stage, fraction, counts };
}

/** Rough labelling time for a script of this size, used only to pace the bar between updates. */
export function estimateLabelMs(linesTotal: number): number {
  return 15_000 + linesTotal * 4;
}

/**
 * The bar's position: the real fraction, nudged forward by elapsed time so it keeps moving while
 * the model is thinking, but never more than 12% ahead of real progress and never past 95%.
 */
export function displayFraction(real: number, elapsedMs: number, estimateMs: number): number {
  const paced = Math.min(0.95, Math.max(0, elapsedMs / Math.max(1, estimateMs)));
  return Math.min(1, Math.max(real, Math.min(paced, real + 0.12, 0.95)));
}
