export type LineKind = "dialogue" | "stage_direction" | "heading";

// One line as a parser emits it, before characters and sections are resolved.
export interface ParsedLine {
  kind: LineKind;
  speaker: string | null; // canonical name the parser proposes
  speakerAsWritten: string | null; // the cue as it appeared ("HAM.")
  text: string;
  act: string | null; // only set on heading lines that start an act or scene
  scene: string | null;
  flagReason: string | null;
}

export interface StructuredScript {
  sections: { act: string | null; scene: string | null; title: string }[];
  characters: { name: string; aliases: string[] }[];
  lines: { section: number; kind: LineKind; character: string | null; text: string; flagReason: string | null }[];
}

export interface ParseUsage {
  parser: "llm" | "heuristic" | "mixed";
  model: string | null;
  chunks: number;
  fallbackChunks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  droppedChars: number;
}
