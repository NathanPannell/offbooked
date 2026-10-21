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

/**
 * The line to record after `afterId`, going round from there: first one nobody has recorded, else
 * one without the person's own take (someone else's plays for now). Null when every line has theirs.
 */
export function nextToRecord(
  lines: readonly { id: string; recorded: boolean; mine: boolean }[],
  afterId: string,
  skip: ReadonlySet<string> = new Set(),
): string | null {
  const index = lines.findIndex((l) => l.id === afterId);
  const ordered = [...lines.slice(index + 1), ...lines.slice(0, index + 1)].filter((l) => !skip.has(l.id));
  return (ordered.find((l) => !l.recorded) ?? ordered.find((l) => !l.mine))?.id ?? null;
}
