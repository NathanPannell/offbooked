import { parseHeading } from "./heuristic.ts";

export interface Chunk {
  index: number;
  text: string;
  context: string; // tail of the previous chunk, for orientation only
}

// Splits on line boundaries, preferring scene headings, then blank lines, so a speech is rarely
// cut in half. Chunks never overlap; the previous chunk's tail is passed along as context.
export function chunkScript(text: string, maxChars = 12_000, contextChars = 600): Chunk[] {
  const lines = text.split("\n").flatMap((l) => (l.length > maxChars / 2 ? splitLongLine(l, maxChars / 2) : [l]));
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let lastBlank = -1;

  const cut = (at: number) => {
    chunks.push(current.slice(0, at).join("\n"));
    current = current.slice(at);
    size = current.reduce((n, l) => n + l.length + 1, 0);
    lastBlank = current.findLastIndex((l) => !l.trim());
  };

  for (const line of lines) {
    if (size > maxChars * 0.5 && parseHeading(line.trim())) cut(current.length);
    current.push(line);
    size += line.length + 1;
    if (!line.trim()) lastBlank = current.length - 1;
    if (size >= maxChars) cut(lastBlank > current.length * 0.3 ? lastBlank + 1 : current.length);
  }
  if (current.some((l) => l.trim())) chunks.push(current.join("\n"));

  return chunks
    .filter((c) => c.trim())
    .map((c, index, all) => ({ index, text: c, context: index > 0 ? all[index - 1]!.slice(-contextChars) : "" }));
}

function splitLongLine(line: string, max: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const at = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf(" ", max));
    const cutAt = at > max * 0.3 ? at + 1 : max;
    parts.push(rest.slice(0, cutAt));
    rest = rest.slice(cutAt);
  }
  parts.push(rest);
  return parts;
}
