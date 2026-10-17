import type { Line, LineKind } from "../../api/types";

// Joining two neighbouring lines and splitting one, as the review shows and undoes them.
// The server joins the lower line into the upper one with a newline; the upper line keeps its id,
// kind and speaker.

export type SpeakerNames = (characterId: string) => string | undefined;

/** Who (or what) a line is, for labels: the speaker's name, or the kind of line. */
export function lineOwner(line: Line, names: SpeakerNames): string {
  if (line.kind === "dialogue") return (line.characterId && names(line.characterId)) || "nobody yet";
  return line.kind === "stage_direction" ? "a direction" : "a heading";
}

export interface JoinPreview {
  /** Short text on the join control. */
  label: string;
  /** Spoken description: both lines and who ends up with the text. */
  description: string;
  /** True when the lines belong to different speakers (or kinds): the upper one wins. */
  differs: boolean;
  /** What the undo bar says after the join. */
  done: string;
}

const sameOwner = (a: Line, b: Line) => a.kind === b.kind && (a.kind !== "dialogue" || a.characterId === b.characterId);

/** "HORATIO's line", "the direction", "the heading". */
function describe(line: Line, names: SpeakerNames): string {
  if (line.kind === "stage_direction") return "the direction";
  if (line.kind === "heading") return "the heading";
  const name = line.characterId && names(line.characterId);
  return name ? `${name}'s line` : "the line with no speaker";
}

export function joinPreview(upper: Line, lower: Line, names: SpeakerNames): JoinPreview {
  const differs = !sameOwner(upper, lower);
  const up = lineOwner(upper, names);
  if (!differs) {
    return {
      label: "Join",
      description: upper.kind === "dialogue" ? `Join these two lines of ${up}` : "Join these two lines",
      differs,
      done: "Lines joined",
    };
  }
  const dialogue = upper.kind === "dialogue" && !!upper.characterId;
  return {
    label: dialogue ? `Join as ${up}` : `Join into ${describe(upper, names).replace(/^the /, "")}`,
    description: `Join ${describe(lower, names)} into ${describe(upper, names)} above.${dialogue ? ` It all becomes ${up}'s.` : ""}`,
    differs,
    done: dialogue ? `Joined. It's all ${up}'s now` : `Joined into ${describe(upper, names)} above`,
  };
}

/** Seams appear only between lines of the same scene; the editor can still join across scenes. */
export function canJoinAtSeam(upper: Line | undefined, lower: Line | undefined): boolean {
  return !!upper && !!lower && upper.sectionId === lower.sectionId && lower.seq === upper.seq + 1;
}

export interface SplitSecond {
  kind: LineKind;
  characterId: string | null;
  sourceLine?: number | null;
  sourcePage?: number | null;
}

export interface UndoJoin {
  /** Split the joined line here (the end of the upper line's text). */
  at: number;
  /** What the lower line was, so the split brings it back exactly (speaker and place in the source). */
  second: SplitSecond;
}

export function undoJoin(upper: Line, lower: Line): UndoJoin {
  return {
    at: upper.text.length,
    second: {
      kind: lower.kind,
      characterId: lower.kind === "dialogue" ? lower.characterId : null,
      sourceLine: lower.sourceLine ?? null,
      sourcePage: lower.page ?? null,
    },
  };
}

export interface SplitPoint {
  /** Character offset the new line starts at. */
  at: number;
  word: string;
}

/**
 * Where a line can be split: before every word after the first. Tapping a word starts the new line
 * with it. Offsets match the server's `split` (it trims both halves).
 */
export function splitPoints(text: string): SplitPoint[] {
  const out: SplitPoint[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(text))) {
    if (!first) out.push({ at: m.index, word: m[0] });
    first = false;
  }
  return out;
}

/** The text cut into words and the spaces between them, each word with its split offset (null for the first). */
export function splitTokens(text: string): { text: string; at: number | null; space: boolean }[] {
  const out: { text: string; at: number | null; space: boolean }[] = [];
  const re = /(\s+)|(\S+)/g;
  let m: RegExpExecArray | null;
  let seenWord = false;
  while ((m = re.exec(text))) {
    if (m[1]) out.push({ text: m[1], at: null, space: true });
    else {
      out.push({ text: m[2]!, at: seenWord ? m.index : null, space: false });
      seenWord = true;
    }
  }
  return out;
}
