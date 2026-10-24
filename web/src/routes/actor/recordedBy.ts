// Who recorded a line's take, and where the recorder opens. Parts aren't owned: anyone's take
// counts as the line being recorded, and the take card says whose it is.

import type { ActorLine, Take } from "../../api/types";

export interface TakeAuthor {
  kind: "actor" | "director";
  name: string;
  /** Recorded by the person looking at it. */
  mine: boolean;
}

/** Who recorded a take. */
export function takeAuthor(take: Take): TakeAuthor {
  return { kind: take.recordedBy.kind, name: take.recordedBy.name, mine: take.mine };
}

/** The take that plays for a line now, and who recorded it: the actor's own, else someone else's in its place. */
export function lineTake(l: ActorLine): { url: string; durationMs: number | null; author: TakeAuthor } | null {
  if (l.take) return { url: l.take.audioUrl, durationMs: l.take.durationMs, author: takeAuthor(l.take) };
  if (l.current) return { url: l.current.audioUrl, durationMs: null, author: { ...l.current.recordedBy, mine: false } };
  return null;
}

/** The person's own take on a line, if the line's take is theirs. */
export function ownTake(l: ActorLine): Take | null {
  return l.take?.mine ? l.take : null;
}

export function recordedByLabel(author: TakeAuthor): string {
  return author.mine ? "Recorded by you" : `Recorded by ${author.name}`;
}

/** Recorded by anyone: this actor, another cast member or the director. */
export function lineRecorded(l: ActorLine): boolean {
  return !!l.take || !!l.current;
}

/**
 * Whether the recorder opens on "You're wrapped": every line is recorded and some of it by this
 * person. Someone who picks up a part others have already recorded lands on the lines instead,
 * to listen and record their own.
 */
export function opensOnWrapped(lines: readonly ActorLine[]): boolean {
  return lines.length > 0 && lines.every(lineRecorded) && lines.some((l) => !!ownTake(l));
}

/** Whether a line belongs to a part: its speaker, or one of a shared line's voices. */
export function saysPart(l: ActorLine, characterId: string): boolean {
  return l.line.characterId === characterId || (l.line.voiceIds ?? []).includes(characterId);
}

/**
 * The part in view for someone with several: the one they chose, else the first with lines that
 * still need a voice (else the first). The recorder keeps the one it opened on (`chosen`) so that
 * finishing its last line shows that part's wrapped screen, not the next part's.
 */
export function partInView(parts: readonly { id: string }[], chosen: string | null, lines: readonly ActorLine[]): string | null {
  if (parts.length <= 1) return null;
  if (chosen && parts.some((p) => p.id === chosen)) return chosen;
  return (parts.find((p) => lines.some((l) => saysPart(l, p.id) && !lineRecorded(l))) ?? parts[0]!).id;
}

/**
 * The line to record after `afterId`, going round from there: one nobody has recorded. Null once
 * every line is recorded (anyone's take counts), which is when the part is wrapped. `overOthers`
 * (the take just made was over someone else's) carries on to the next line without the person's
 * own take instead, so recording over the others' takes walks through them.
 */
export function nextToRecord(
  lines: readonly { id: string; recorded: boolean; mine: boolean }[],
  afterId: string,
  skip: ReadonlySet<string> = new Set(),
  overOthers = false,
): string | null {
  const index = lines.findIndex((l) => l.id === afterId);
  const ordered = [...lines.slice(index + 1), ...lines.slice(0, index + 1)].filter((l) => !skip.has(l.id));
  return (ordered.find((l) => !l.recorded) ?? (overOthers ? ordered.find((l) => !l.mine) : undefined))?.id ?? null;
}
