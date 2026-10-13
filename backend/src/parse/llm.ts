import Anthropic from "@anthropic-ai/sdk";
import type { Chunk } from "./chunk.ts";
import type { ParsedLine } from "./types.ts";

export interface ChunkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface ChunkRequest {
  chunk: Chunk;
  total: number;
  speakerHints: string[];
}

// Owner decision: every Claude call uses Haiku. Never escalate to a larger model; when Haiku's
// output fails validation the pipeline retries once with Haiku, then uses the heuristic parser.
export const PARSE_MODEL = "claude-haiku-5-5";

// The seam the pipeline and tests use; the real implementation calls Claude.
export type ChunkParser = (req: ChunkRequest) => Promise<{ lines: ParsedLine[]; usage: ChunkUsage }>;

const nullable = (type: "string") => ({ anyOf: [{ type }, { type: "null" }] });

export const LINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "speaker", "speakerAsWritten", "text", "act", "scene", "uncertain", "note"],
        properties: {
          kind: { type: "string", enum: ["dialogue", "stage_direction", "heading"] },
          speaker: nullable("string"),
          speakerAsWritten: nullable("string"),
          text: { type: "string" },
          act: nullable("string"),
          scene: nullable("string"),
          uncertain: { type: "boolean" },
          note: nullable("string"),
        },
      },
    },
  },
} as const;

const SYSTEM = `You convert theatre scripts into structured lines for a rehearsal app. Actors record each dialogue line, so speaker attribution and exact wording matter.

Output every piece of text from the excerpt, in order, as a list of lines:
- "dialogue": words a character speaks. "speaker" is the character's full canonical name in capitals (for example "HAMLET" even when the cue reads "HAM." or "Ham."). "speakerAsWritten" is the cue exactly as printed. "text" is the speech without the cue.
- "stage_direction": anything not spoken: entrances, exits, actions, parentheticals such as "(aside)" or "[He sits]", character descriptions, front matter like a title page or cast list. If a direction sits inside a speech, split the speech around it so the direction is its own line between two dialogue lines with the same speaker.
- "heading": act and scene headings, and section titles. For an act or scene heading, set "act" and/or "scene" as Arabic numerals ("ACT II" gives act "2", "SCENE iii" gives scene "3", "II.iii" gives act "2" and scene "3"); for a screenplay slugline put the whole slugline in "scene". Leave both null on other lines.

Rules:
- Copy wording exactly. Do not paraphrase, modernise, correct, translate or summarise. Join lines that the page wrapped, but keep every word.
- Drop only page numbers and running page headers or footers.
- One speech by one speaker is one dialogue line, however long, unless a stage direction splits it.
- Set "uncertain": true with a short "note" when you are unsure about the speaker, the kind, or where a line starts or ends. Otherwise "uncertain" is false and "note" is null.
- The excerpt may start or end mid-speech. Text before the first cue in the excerpt usually continues the speech from the context; attribute it to that speaker and mark it uncertain if you cannot tell.`;

export function createClaudeChunkParser(apiKey: string): ChunkParser {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return async ({ chunk, total, speakerHints }) => {
    const prompt = [
      `Excerpt ${chunk.index + 1} of ${total}.`,
      speakerHints.length ? `Speaker cues seen across the whole script: ${speakerHints.join(", ")}.` : "",
      chunk.context ? `Context (end of the previous excerpt, already handled; do not output it):\n<context>\n${chunk.context}\n</context>` : "",
      `Excerpt to convert:\n<excerpt>\n${chunk.text}\n</excerpt>`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const stream = client.messages.stream({
      model: PARSE_MODEL,
      max_tokens: 32_000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: LINE_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Claude declined to parse this excerpt");
    if (message.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens on this excerpt");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const lines = toParsedLines(JSON.parse(text));
    return {
      lines,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  };
}

interface RawLine {
  kind: ParsedLine["kind"];
  speaker: string | null;
  speakerAsWritten: string | null;
  text: string;
  act: string | null;
  scene: string | null;
  uncertain: boolean;
  note: string | null;
}

// Re-checks the schema shape: a truncated or malformed response must fail the chunk, not slip through.
export function toParsedLines(value: unknown): ParsedLine[] {
  const lines = (value as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) throw new Error("Parser output has no lines array");
  return lines.map((raw: RawLine, i) => {
    if (!raw || typeof raw.text !== "string" || !["dialogue", "stage_direction", "heading"].includes(raw.kind)) {
      throw new Error(`Parser output line ${i} is malformed`);
    }
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const flagReason = raw.uncertain ? (str(raw.note) ?? "The parser was unsure about this line") : null;
    const speaker = raw.kind === "dialogue" ? str(raw.speaker) : null;
    return {
      kind: raw.kind,
      speaker,
      speakerAsWritten: speaker ? str(raw.speakerAsWritten) : null,
      text: raw.text,
      act: raw.kind === "heading" ? str(raw.act) : null,
      scene: raw.kind === "heading" ? str(raw.scene) : null,
      flagReason,
    };
  });
}
