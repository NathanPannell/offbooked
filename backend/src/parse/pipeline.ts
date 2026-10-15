import type { Log } from "../log.ts";
import { abbreviates, assembleSegments, PARENTHESES, type AssembledLine } from "./assemble.ts";
import { learnCues, reclaimSkips, repairCues } from "./cues.ts";
import { canonicalName, heuristicParse, parseHeading } from "./heuristic.ts";
import { flag } from "./flags.ts";
import { PARSE_MODEL, type Labeler, type Segment } from "./label.ts";
import { stripLineNumbers } from "./noise.ts";
import { PAGE_BREAK, ScriptInputError } from "./pdf.ts";
import { buildStructure, validateStructure } from "./structure.ts";
import type { ParsedLine, ParseUsage, StructuredScript } from "./types.ts";

export const MAX_SCRIPT_CHARS = 600_000;
// Every chunk is labelled at once; the cap only matters for very long scripts.
const MAX_PARALLEL_CHUNKS = 64;
const MAX_ATTEMPTS = 4;
const CHUNK_LINES = 180;
const MAX_CHUNK_CHARS = 14_000;
const FALLBACK_NOTE = flag("backup");
const GAP_NOTE = flag("text", "This line wasn't labelled by the parser");

export function cleanScriptText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\xa0 -  ]/g, " ")
    .replace(/[​﻿]/g, "")
    .replace(/[ ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Claude (Haiku) labels numbered line ranges; the text itself always comes from the source.
// A chunk whose labels fail validation is retried once, then read by the heuristic parser with
// its lines flagged, so a parse always produces something the director can correct.
export async function parseScriptText(
  rawText: string,
  opts: { labeler: Labeler | null; log: Log; onProgress?: (p: LabelProgress) => void },
): Promise<{ structure: StructuredScript; usage: ParseUsage }> {
  const { text, report } = prepareText(rawText);
  if (!text) throw new ScriptInputError("The script is empty. Paste the text or upload a file.");
  if (text.length > MAX_SCRIPT_CHARS) throw new ScriptInputError("This script is too long to process. Split it into parts under 600,000 characters.");

  const heuristic = heuristicParse(text);
  const usage: ParseUsage = {
    parser: "heuristic",
    model: null,
    chunks: 1,
    fallbackChunks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    droppedChars: 0,
    lineNumbers: report,
  };
  let lines: ParsedLine[] = heuristic;

  if (opts.labeler) {
    const labeler = opts.labeler;
    const docLines = text.split("\n");
    const ranges = chunkRanges(docLines);
    usage.chunks = ranges.length;
    usage.model = PARSE_MODEL;
    const contentIn = (from: number, to: number) => docLines.slice(from - 1, to).filter((l) => l.trim()).length;
    const linesTotal = contentIn(1, docLines.length);
    const progress: LabelProgress = { chunksDone: 0, chunksTotal: ranges.length, linesDone: 0, linesTotal, scenes: 0, speeches: 0 };
    // Live counts per chunk, updated as rows stream in, so progress moves while every chunk is
    // still running (they all start together and would otherwise finish together).
    const live = ranges.map(() => ({ upTo: 0, scenes: 0, speeches: 0 }));
    const report = () => {
      progress.linesDone = live.reduce((n, c, i) => n + (c.upTo ? contentIn(ranges[i]![0], Math.min(c.upTo, ranges[i]![1])) : 0), 0);
      progress.scenes = live.reduce((n, c) => n + c.scenes, 0);
      progress.speeches = live.reduce((n, c) => n + c.speeches, 0);
      opts.onProgress?.({ ...progress });
    };
    report();
    const results = await mapLimit(ranges, MAX_PARALLEL_CHUNKS, async ([from, to], index) => {
      // Keep every valid row and re-ask from the first unlabelled line: the model sometimes stops
      // early or skips a stretch, and relabelling only the rest is cheaper and more reliable.
      const kept: Segment[] = [];
      let cursor = from;
      const onRows = (rows: Segment[]) => {
        const c = live[index]!;
        for (const r of rows) {
          if (r.from < cursor || r.to > to) continue;
          c.upTo = Math.max(c.upTo, r.to);
          if (r.type === "speech") c.speeches++;
          if (r.type === "heading" && (r.act || r.scene)) c.scenes++;
        }
        report();
      };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && cursor <= to; attempt++) {
        try {
          const res = await labeler({ lines: docLines, from: cursor, to, knownSpeakers: [], onRows });
          usage.inputTokens += res.usage.inputTokens;
          usage.outputTokens += res.usage.outputTokens;
          usage.cacheReadTokens += res.usage.cacheReadTokens;
          const prefix = validPrefix(res.segments, docLines, cursor, to);
          kept.push(...prefix.segments);
          if (prefix.next <= to) opts.log.warn({ chunk: index, attempt, from: cursor, stoppedAt: prefix.next, to }, "chunk labels stopped early; relabelling the rest");
          cursor = prefix.next;
        } catch (err) {
          opts.log.warn({ err: String(err), chunk: index, attempt }, "chunk labelling failed");
        }
      }
      let fallback: ParsedLine[] = [];
      if (cursor <= to) {
        usage.fallbackChunks += 1;
        fallback = heuristicParse(docLines.slice(cursor - 1, to).join("\n")).map((l) => ({ ...l, flag: l.flag ?? FALLBACK_NOTE }));
      }
      progress.chunksDone++;
      live[index] = {
        upTo: to,
        scenes: kept.filter((sg) => sg.type === "heading" && (sg.act || sg.scene)).length,
        speeches: kept.filter((sg) => sg.type === "speech").length + fallback.filter((l) => l.kind === "dialogue").length,
      };
      report();
      return { segments: kept, fallback };
    });
    // Cues are learnt across the whole script, then used to repair each chunk's blocks.
    const book = learnCues(results.flatMap((r) => r.segments), docLines);
    const parenDirections = usesParenDirections(results.flatMap((r) => r.segments), docLines);
    const firstSpeechChunk = results.findIndex((r) => r.segments.some((sg) => sg.type === "speech"));
    const assembled = results.map((r, i) => {
      const reclaimed = reclaimSkips(r.segments, docLines, book, firstSpeechChunk >= 0 && i > firstSpeechChunk);
      return [...assembleSegments(repairCues(reclaimed, docLines, book), docLines, { parenDirections }), ...r.fallback];
    });
    lines = unifySpeakers(joinContinuations(assembled));
    usage.parser = usage.fallbackChunks === 0 ? "llm" : usage.fallbackChunks === ranges.length ? "heuristic" : "mixed";
  }

  const structure = buildStructure(locateLines(lines, text.split("\n")));
  const pageOf = pageIndex(text.split("\n"));
  for (const l of structure.lines) l.page = l.sourceLine ? pageOf(l.sourceLine) : null;
  if (!structure.lines.some((l) => l.kind === "dialogue")) throw new ScriptInputError("We couldn't find any dialogue in this file. Check it's a script, or paste the text instead.");
  const problems = validateStructure(structure);
  if (problems.length) throw new Error(`Parsed script failed validation: ${problems.slice(0, 5).join("; ")}`);
  return { structure, usage };
}

// How far labelling has got, for the director's progress bar.
export interface LabelProgress {
  chunksDone: number;
  chunksTotal: number;
  linesDone: number;
  linesTotal: number;
  scenes: number; // act and scene headings found so far
  speeches: number;
}

// Line ranges of about CHUNK_LINES non-blank lines, cut at a heading or blank line near the end.
export function chunkRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 1;
  let count = 0;
  let chars = 0;
  let bestCut = -1;
  for (let n = 1; n <= lines.length; n++) {
    const l = lines[n - 1]!;
    if (l.trim()) {
      count++;
      chars += l.length + 1;
    }
    const nearEnd = count >= CHUNK_LINES * 0.75 || chars >= MAX_CHUNK_CHARS * 0.75;
    if (nearEnd && n < lines.length) {
      const next = lines[n]!;
      if (parseHeading(next.trim())) bestCut = n;
      else if (!l.trim() && bestCut < 0) bestCut = n;
    }
    if (count >= CHUNK_LINES || chars >= MAX_CHUNK_CHARS) {
      const end = bestCut > start ? bestCut : n;
      ranges.push([start, end]);
      start = end + 1;
      count = 0;
      chars = 0;
      for (let k = start; k <= n; k++) {
        if (lines[k - 1]!.trim()) {
          count++;
          chars += lines[k - 1]!.length + 1;
        }
      }
      bestCut = -1;
    }
  }
  if (start <= lines.length && lines.slice(start - 1).some((l) => l.trim())) ranges.push([start, lines.length]);
  return ranges;
}

// The longest run of rows that labels the range in order from its start. One or two unlabelled
// lines are attached to the block before them (flagged); a bigger gap ends the run there.
export function validPrefix(segments: Segment[], lines: string[], from: number, to: number): { segments: Segment[]; next: number } {
  const sorted = [...segments].filter((s) => s.to >= s.from && s.from >= from && s.from <= to).sort((a, b) => a.from - b.from || (a.type === "skip" ? 1 : 0) - (b.type === "skip" ? 1 : 0));
  const out: Segment[] = [];
  let next = from;
  const contentBetween = (a: number, b: number) => lines.slice(a - 1, b).filter((l) => l.trim()).length;
  for (const s of sorted) {
    if (s.type === "speech" && !s.speaker) break;
    // On overlap, play content beats "not part of the play": cut the skip row back instead.
    const prev = out[out.length - 1];
    if (s.from < next && s.type !== "skip" && prev?.type === "skip" && s.from >= prev.from) {
      prev.to = s.from - 1;
      if (prev.to < prev.from) out.pop();
      next = s.from;
    }
    if (s.to < next) continue;
    const seg = { ...s, from: Math.max(s.from, next), to: Math.min(s.to, to) };
    const gap = contentBetween(next, seg.from - 1);
    if (gap > 2) break;
    if (gap > 0) {
      const prev = out[out.length - 1];
      if (prev && prev.type !== "skip") {
        prev.to = seg.from - 1;
        prev.flag ??= GAP_NOTE;
      } else {
        out.push({ from: next, to: seg.from - 1, type: "direction", speaker: null, cue: null, act: null, scene: null, inlineDirections: [], flag: GAP_NOTE });
      }
    }
    out.push(seg);
    next = seg.to + 1;
  }
  // A wrapped speech line labelled "not part of the play" ("instantly; or else seek…") belongs to
  // the speech above it. Page furniture never starts in lower case, so that stays skipped.
  for (let i = 1; i < out.length; i++) {
    const seg = out[i]!;
    const prev = out[i - 1]!;
    if (seg.type !== "skip" || (prev.type !== "speech" && prev.type !== "continue") || seg.from !== prev.to + 1) continue;
    const content = lines.slice(seg.from - 1, seg.to).filter((l) => l.trim());
    if (content.length && content.length <= 3 && content.every((l) => /^\s*[\p{Ll}]/u.test(l))) {
      prev.to = seg.to;
      out.splice(i--, 1);
    }
  }
    // Trailing blank lines need no label.
  while (next <= to && !lines[next - 1]!.trim()) next++;
  if (next <= to && contentBetween(next, to) <= 2 && out.length) {
    const prev = out[out.length - 1]!;
    if (prev.type !== "skip") {
      prev.to = to;
      prev.flag ??= GAP_NOTE;
      next = to + 1;
    }
  }
  return { segments: out, next };
}

// A chunk that starts mid-speech labels its first lines as a continuation; join them to the
// speech they continue, or give them that speech's speaker after an interrupting direction.
export function joinContinuations(chunks: AssembledLine[][]): ParsedLine[] {
  const out: ParsedLine[] = [];
  let lastSpeaker: { speaker: string | null; speakerAsWritten: string | null } | null = null;
  let cuePending = false;
  for (const chunk of chunks) {
    for (const l of chunk) {
      const { continuation, cueOnly, ...line } = l;
      if (cueOnly) {
        lastSpeaker = { speaker: line.speaker, speakerAsWritten: line.speakerAsWritten };
        cuePending = true;
        continue;
      }
      if (continuation && cuePending && lastSpeaker) {
        Object.assign(line, lastSpeaker);
      } else if (continuation) {
        const prev = out[out.length - 1];
        if (prev?.kind === "dialogue") {
          prev.text = `${prev.text}\n${line.text}`;
          continue;
        }
        if (lastSpeaker) Object.assign(line, lastSpeaker);
        else line.flag ??= flag("direction", "No speaker found for this line");
      }
      if (line.kind === "dialogue" && line.speaker) lastSpeaker = { speaker: line.speaker, speakerAsWritten: line.speakerAsWritten };
      if (line.kind === "dialogue") cuePending = false;
      out.push(line);
    }
  }
  return out;
}

// Some scripts put stage directions in parentheses inside speeches ("(Exit Hale door rear.)"),
// others use parentheses for spoken asides in verse. The model marks the direction ones; when it
// marked most of a script's parentheticals, the script uses that convention and all are cut.
export function usesParenDirections(segments: Segment[], lines: string[]): boolean {
  let total = 0;
  let marked = 0;
  let standalone = 0;
  for (const s of segments) {
    if (s.type === "direction" && /^\(.*\)\.?$/.test(lines.slice(s.from - 1, s.to).join(" ").trim())) standalone++;
    if (s.type !== "speech" && s.type !== "continue") continue;
    const text = lines.slice(s.from - 1, s.to).join(" ");
    for (const m of text.matchAll(PARENTHESES)) {
      total++;
      if (s.inlineDirections.some((d) => d.includes(m[0].slice(1, -1).trim().slice(0, 20)))) marked++;
    }
  }
  // Directions printed as "(Aside)" on their own lines mean the script's parentheses are directions.
  return standalone >= 3 || (total >= 3 && marked / total >= 0.4);
}

// Chunks are labelled independently, so the same printed cue can come back under two names
// ("KING" in one chunk, "CLAUDIUS" in another). Each cue goes to its most common name.
export function unifySpeakers(lines: ParsedLine[]): ParsedLine[] {
  const byCue = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (l.kind !== "dialogue" || !l.speaker || !l.speakerAsWritten) continue;
    const cue = canonicalName(l.speakerAsWritten);
    const names = byCue.get(cue) ?? new Map<string, number>();
    names.set(l.speaker, (names.get(l.speaker) ?? 0) + 1);
    byCue.set(cue, names);
  }
  const preferred = new Map<string, string>();
  for (const [cue, names] of byCue) {
    // A short cue that fits two names ("Sec." for SECOND PILGRIM and SECOND OFFICER) is shared,
    // not inconsistent; only a cue that fits one of its names is unified ("KING" over "CLAUDIUS").
    if ([...names.keys()].filter((name) => abbreviates(cue, name)).length > 1) continue;
    preferred.set(cue, [...names].sort((a, b) => b[1] - a[1])[0]![0]);
  }
  return lines.map((l) => {
    if (l.kind !== "dialogue" || !l.speaker || !l.speakerAsWritten) return l;
    const name = preferred.get(canonicalName(l.speakerAsWritten));
    return name && name !== l.speaker ? { ...l, speaker: name } : l;
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The text every later step sees, and the source view shows: cleaned, with line numbers removed.
// Parsed lines point at its line numbers, so it must be reproducible from the stored raw text.
export function prepareText(rawText: string): { text: string; report: ReturnType<typeof stripLineNumbers>["report"] } {
  return stripLineNumbers(cleanScriptText(rawText));
}

// Page of each prepared line, counted from the page-break lines a PDF extraction leaves; null
// for sources without pages.
export function pageIndex(docLines: string[]): (line: number) => number | null {
  const breaks: number[] = [];
  docLines.forEach((l, i) => {
    if (l === PAGE_BREAK) breaks.push(i + 1);
  });
  if (!breaks.length) return () => null;
  return (line) => {
    let page = 1;
    for (const b of breaks) if (b < line) page++;
    return page;
  };
}

const locateKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Lines from the heuristic fallback carry no position; find each one in the source, searching on
// from the line before it.
export function locateLines(lines: ParsedLine[], docLines: string[]): ParsedLine[] {
  const keys = docLines.map(locateKey);
  let from = 0;
  return lines.map((l) => {
    if (l.sourceLine) {
      from = l.sourceLine - 1;
      return l;
    }
    // The first dozen letters of the line, found inside a source line (or a short source line
    // found at the start of the line text).
    const head = locateKey(l.text).slice(0, 12);
    if (head.length < 4) return l;
    for (let i = from; i < keys.length; i++) {
      const key = keys[i]!;
      if (key.length >= 4 && (key.includes(head) || head.startsWith(key))) {
        from = i;
        return { ...l, sourceLine: i + 1 };
      }
    }
    return l;
  });
}
