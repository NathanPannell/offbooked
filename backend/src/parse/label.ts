import Anthropic from "@anthropic-ai/sdk";

// Owner decision: every Claude call uses Haiku. Never escalate to a larger model; when Haiku's
// labels fail validation the pipeline retries once with Haiku, then uses the heuristic parser.
export const PARSE_MODEL = "claude-haiku-5-5";

export type SegmentType = "speech" | "continue" | "direction" | "heading" | "skip";

// One labelled block of consecutive source lines (1-based, inclusive).
export interface Segment {
  from: number;
  to: number;
  type: SegmentType;
  speaker: string | null; // canonical name, speech only
  cue: string | null; // the cue as printed, when it differs from the speaker
  act: string | null;
  scene: string | null;
  inlineDirections: string[]; // directions printed inside a speech
  note: string | null; // set when the model is unsure
}

export interface LabelRequest {
  lines: string[]; // the whole document; index 0 is line 1
  from: number; // first line to label (1-based)
  to: number; // last line to label (inclusive)
  knownSpeakers: string[];
  // Called with each complete row as the model streams it, for live progress.
  onRows?: (rows: Segment[]) => void;
}

export interface LabelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type Labeler = (req: LabelRequest) => Promise<{ segments: Segment[]; usage: LabelUsage }>;

const CONTEXT_LINES = 12;
// Labelling is mostly pattern-following; low effort keeps each chunk fast. Raise it only if the
// benchmark (bench/run.ts) shows speaker accuracy gains that are worth the latency.
export const LABEL_EFFORT = "medium";

const SYSTEM = `You label the lines of a theatre script for a rehearsal app. Actors record every speech, so who says what must be exactly right.

You get numbered lines. Reply with rows that cover every non-blank numbered line between FROM and TO exactly once, in order, one row per block of consecutive lines:

<from>-<to> S <SPEAKER> | <cue as printed>   a speech: everything one character says until the next cue or stage direction. Include the line that holds the cue.
<from>-<to> C                                 lines at the very start that continue a speech already in progress in the context
<from>-<to> D                                 a stage direction: entrances, exits, actions, settings, descriptions, parentheticals on their own line
<from>-<to> H act=<n> scene=<n>               an act or scene heading (omit act= or scene= when the heading has no such part; use Arabic numerals)
                                               A setting such as "SCENE.—An island" or "The scene is a kitchen" is D, not H.
<from>-<to> X                                 not part of the play itself

Write a single line as "<n> S ..." without "-<to>". Blank lines need no row but may sit inside a block.

Speeches:
- SPEAKER is the character's full name in capitals, spelled as the script prints it (never modernise old spellings: "EUERY MAN" stays) and the same way every time (HAMLET even when the cue reads "HAM." or "Ham."; KING for "King."; "SECOND OFFICER" for "Sec. Off.").
- After "|", give only the speaker cue as printed, never the spoken words: for "HAM. To be, or not to be" write "| HAM."; for "BARNARDO Who's there?" write "| BARNARDO". Leave out "| ..." only when the speech has no cue (a C row never has one).
- Cues can sit on their own line above the speech, at the start of the first line, or after a line reference. A new cue always starts a new S row: a line that is only a character name, like "POLONIUS" or "HAMLET, aside", is the cue of the next speech.
- If a stage direction is printed inside a speech, on the same line as spoken words, add " >> <the direction text exactly as printed>" to the row for each one, e.g. "Give you good night. Francisco exits." gives ">> Francisco exits." and "[Aside] I'll do it." gives ">> [Aside]". A direction on its own line between two parts of a speech is its own D row instead. Parentheses inside verse or prose that are part of what the character says are not directions; a parenthesis is a direction only when it describes action or delivery, like "(aside)" or "(to Ben)".
- Songs, prologues, epilogues and choruses that are spoken or sung are speeches.
- A speech carries on across stage directions, page breaks and blank lines. Spoken words that follow a direction with no new cue still belong to the previous speaker: label them "S <that same SPEAKER>" without "| cue" (or C at the very start of the excerpt). Only add "??" when it is genuinely unclear who is speaking.
- A speech can open with a direction before the words, e.g. "NORA." then "_In a low voice._—Where is she?" or "HAM. [Aside] A little more than kin". That line is still part of the speech: label it with the speech and mark the direction with ">>".

Not part of the play (X): title pages, contents, copyright and licence text, introductions, essays, synopses, notes, footnotes, glossaries, lists of characters or cast, production notes, advertisements, running page headers and page numbers. Everything from the first act/scene heading or first stage direction or speech of the play to its end is the play.

When unsure about a row, end it with " ?? <short reason>". Output only the rows, nothing else.`;

const EXAMPLE_INPUT = `FROM 101 TO 114

101| THE TRAGEDY OF EXAMPLE
102| Characters in the Play
103| ANNA, a widow
104| ACT 1
105| Scene 2
106| Enter Anna and Ben.
107| BEN Where were you last night?
108| ANNA
109| Out. Ask me no more. [She sits.]
110| Ben. Then I'll ask the moon. He crosses
111| to the window. Exit.
112| ANNA (to herself)
113| Gone.
114| 47`;

const EXAMPLE_OUTPUT = `101-103 X
104 H act=1
105 H scene=2
106 D
107 S BEN | BEN
108-109 S ANNA | ANNA >> [She sits.]
110 S BEN | Ben. >> He crosses
111 D ?? direction split across lines 110-111
112-113 S ANNA | ANNA >> (to herself)
114 X`;

const ROW = /^(\d+)(?:\s*-\s*(\d+))?\s+([SCDHX])\b\s*(.*)$/;

export function createClaudeLabeler(apiKey: string): Labeler {
  // All chunks go out at once, so allow a few more retries for rate limiting (429s back off).
  const client = new Anthropic({ apiKey, maxRetries: 5, timeout: 180_000 });
  return async (req) => {
    const prompt = buildPrompt(req);
    const stream = client.messages.stream({
      model: PARSE_MODEL,
      max_tokens: 32_000,
      output_config: { effort: LABEL_EFFORT },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: EXAMPLE_INPUT },
        { role: "assistant", content: EXAMPLE_OUTPUT },
        { role: "user", content: prompt },
      ],
    });
    if (req.onRows) {
      let buffer = "";
      stream.on("text", (delta) => {
        buffer += delta;
        const end = buffer.lastIndexOf("\n");
        if (end < 0) return;
        const rows = parseRows(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (rows.length) req.onRows!(rows);
      });
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Claude declined to label this excerpt");
    if (message.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens on this excerpt");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return {
      segments: parseRows(text),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      },
    };
  };
}

export function buildPrompt(req: LabelRequest): string {
  const numbered = (from: number, to: number) =>
    req.lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}| ${l}`.trimEnd())
      .join("\n");
  const ctxFrom = Math.max(1, req.from - CONTEXT_LINES);
  return [
    req.knownSpeakers.length ? `Known speakers: ${req.knownSpeakers.join(", ")}` : "",
    req.from > 1 ? `Context (already labelled, do not label):\n${numbered(ctxFrom, req.from - 1)}` : "",
    `FROM ${req.from} TO ${req.to}\n\n${numbered(req.from, req.to)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseRows(text: string): Segment[] {
  const segments: Segment[] = [];
  for (const raw of text.split("\n")) {
    const m = ROW.exec(raw.trim().replace(/^[-*]\s+/, ""));
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    let rest = m[4]!;
    let note: string | null = null;
    const q = rest.indexOf("??");
    if (q >= 0) {
      note = rest.slice(q + 2).trim() || "The parser was unsure about this line";
      rest = rest.slice(0, q);
    }
    const [head, ...directions] = rest.split(">>");
    const inlineDirections = directions.map((d) => d.trim()).filter(Boolean);
    const seg: Segment = { from, to, type: TYPES[m[3] as keyof typeof TYPES], speaker: null, cue: null, act: null, scene: null, inlineDirections, note };
    if (seg.type === "speech") {
      const [speaker, cue] = head!.split("|").map((s) => s.trim());
      seg.speaker = speaker ? speaker.toUpperCase() : null;
      seg.cue = cue || null;
    } else if (seg.type === "heading") {
      seg.act = /act\s*=\s*([\w.]+)/i.exec(head!)?.[1] ?? null;
      seg.scene = /scene\s*=\s*([\w.]+)/i.exec(head!)?.[1] ?? null;
    }
    segments.push(seg);
  }
  return segments;
}

const TYPES = { S: "speech", C: "continue", D: "direction", H: "heading", X: "skip" } as const;

// Every non-blank line in the range must be labelled exactly once, in order.
export function coverageProblem(segments: Segment[], lines: string[], from: number, to: number): string | null {
  let next = from;
  for (const s of segments) {
    if (s.from < from || s.to > to || s.to < s.from) return `row ${s.from}-${s.to} is outside ${from}-${to}`;
    if (s.from < next) return `row ${s.from}-${s.to} overlaps the previous row`;
    for (let n = next; n < s.from; n++) if (lines[n - 1]!.trim()) return `line ${n} is not labelled`;
    if (s.type === "speech" && !s.speaker) return `speech ${s.from}-${s.to} has no speaker`;
    next = s.to + 1;
  }
  for (let n = next; n <= to; n++) if (lines[n - 1]!.trim()) return `line ${n} is not labelled`;
  return null;
}
