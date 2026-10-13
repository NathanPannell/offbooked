import type { Log } from "../log.ts";
import { alignToSource, NOT_FOUND, type AlignResult } from "./align.ts";
import { chunkScript } from "./chunk.ts";
import { heuristicParse } from "./heuristic.ts";
import { PARSE_MODEL, type ChunkParser } from "./llm.ts";
import { ScriptInputError } from "./pdf.ts";
import { buildStructure, validateStructure } from "./structure.ts";
import type { ParsedLine, ParseUsage, StructuredScript } from "./types.ts";

export const MAX_SCRIPT_CHARS = 600_000;
const CONCURRENCY = 4;
const FALLBACK_NOTE = "This part was read by the backup parser; check speakers and stage directions here";

export function cleanScriptText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\xa0]/g, " ")
    .replace(/[ ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Claude (Haiku) when available, chunk by chunk. A chunk whose output fails validation is retried
// once, then parsed by the heuristic parser with every line flagged, so a parse always produces
// something the director can correct.
export async function parseScriptText(
  rawText: string,
  opts: { chunkParser: ChunkParser | null; log: Log },
): Promise<{ structure: StructuredScript; usage: ParseUsage }> {
  const text = cleanScriptText(rawText);
  if (!text) throw new ScriptInputError("The script is empty. Paste the text or upload a PDF.");
  if (text.length > MAX_SCRIPT_CHARS) throw new ScriptInputError("This script is too long to process. Split it into parts under 600,000 characters.");

  const heuristic = heuristicParse(text);
  const usage: ParseUsage = { parser: "heuristic", model: null, chunks: 1, fallbackChunks: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, droppedChars: 0 };
  let lines: ParsedLine[] = heuristic;

  if (opts.chunkParser) {
    const parser = opts.chunkParser;
    const hints = speakerHints(heuristic);
    const chunks = chunkScript(text);
    usage.chunks = chunks.length;
    usage.model = PARSE_MODEL;
    const results = await mapLimit(chunks, CONCURRENCY, async (chunk) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await parser({ chunk, total: chunks.length, speakerHints: hints });
          usage.inputTokens += res.usage.inputTokens;
          usage.outputTokens += res.usage.outputTokens;
          usage.cacheReadTokens += res.usage.cacheReadTokens;
          const cueNames = [...hints, ...res.lines.flatMap((l) => [l.speaker ?? "", l.speakerAsWritten ?? ""])];
          const aligned = alignToSource(chunk.text, res.lines, cueNames);
          const problem = chunkProblem(aligned, res.lines.length);
          if (problem) throw new Error(problem);
          usage.droppedChars += aligned.droppedChars;
          return aligned.lines;
        } catch (err) {
          opts.log.warn({ err, chunk: chunk.index, attempt }, "LLM chunk parse failed validation");
        }
      }
      usage.fallbackChunks += 1;
      return heuristicParse(chunk.text).map((l) => ({ ...l, flagReason: l.flagReason ?? FALLBACK_NOTE }));
    });
    lines = results.flat();
    usage.parser = usage.fallbackChunks === 0 ? "llm" : usage.fallbackChunks === chunks.length ? "heuristic" : "mixed";
  }

  const structure = buildStructure(lines);
  if (!structure.lines.length) throw new ScriptInputError("We couldn't find any script text. Paste the text instead.");
  const problems = validateStructure(structure);
  if (problems.length) throw new Error(`Parsed script failed validation: ${problems.slice(0, 5).join("; ")}`);
  return { structure, usage };
}

// Output that misses or invents a large share of the source is rejected rather than patched.
export function chunkProblem(aligned: AlignResult, outputLines: number): string | null {
  if (!outputLines) return "no lines returned";
  if (aligned.sourceChars && aligned.droppedChars / aligned.sourceChars > 0.15) return "too much source text missing";
  const unmatched = aligned.lines.filter((l) => l.flagReason === NOT_FOUND).length;
  if (unmatched / outputLines > 0.15) return "too much text not found in the source";
  return null;
}

function speakerHints(lines: ParsedLine[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (l.kind !== "dialogue") continue;
    for (const name of [l.speaker, l.speakerAsWritten]) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([name]) => name);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
