import { useCallback, useEffect, useRef, useState } from "react";
import type { Cue, Line } from "../../api/types";

// A take the wrong-line check flagged (see `flubbed` in stt/live.ts), held while the recorder asks
// "Did you mean to say something else?": keep it and carry on (✓), or read the line again (←). The
// ← side counts down and re-records the line by itself, except after the same line was flagged
// twice in a row: then it waits for a tap. Shared by the cast's recorder and the director's studio.

/** How long the ← side counts down before it records the line again by itself. */
export const FLUB_COUNTDOWN_MS = 3000;
/** Flags in a row on one line after which the line is no longer recorded again by itself. */
export const FLUB_AUTO_LIMIT = 2;

/** How many times in a row this line has now been flagged, given the last flag. */
export function flagsInRow(last: { lineId: string; count: number } | null, lineId: string): number {
  return last?.lineId === lineId ? last.count + 1 : 1;
}

/** Whether the ← side counts down to recording the line again by itself. */
export const autoRetake = (count: number) => count < FLUB_AUTO_LIMIT;

export interface FlubView {
  lineId: string;
  /** Seconds left before the line records again by itself, or null when it waits for a tap. */
  secondsLeft: number | null;
}

/**
 * Holds one flagged take at a time. `raise` holds it and starts the countdown; `keep` and `retake`
 * end it (each hands back the held take to its callback); `settled` says a take of the line was
 * kept another way, so the next flag on it counts from one again; `drop` forgets it (the screen
 * started recording something else).
 */
export function useFlubPrompt<T extends { lineId: string }>({ onKeep, onRetake }: { onKeep: (held: T) => void; onRetake: (held: T) => void }) {
  const [held, setHeld] = useState<{ take: T; deadline: number | null } | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const last = useRef<{ lineId: string; count: number } | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const callbacks = useRef({ onKeep, onRetake });
  callbacks.current = { onKeep, onRetake };

  const end = useCallback((how: "keep" | "retake") => {
    const current = heldRef.current;
    if (!current) return;
    heldRef.current = null;
    setHeld(null);
    if (how === "keep") {
      last.current = null;
      callbacks.current.onKeep(current.take);
    } else callbacks.current.onRetake(current.take);
  }, []);

  const raise = useCallback((take: T) => {
    const count = flagsInRow(last.current, take.lineId);
    last.current = { lineId: take.lineId, count };
    const start = performance.now();
    setNow(start);
    setHeld({ take, deadline: autoRetake(count) ? start + FLUB_COUNTDOWN_MS : null });
  }, []);

  // The countdown: ticks for the number shown, and records the line again when it runs out.
  const deadline = held?.deadline ?? null;
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => {
      const t = performance.now();
      setNow(t);
      if (t >= deadline) end("retake");
    }, 100);
    return () => clearInterval(id);
  }, [deadline, end]);

  const view: FlubView | null = held
    ? { lineId: held.take.lineId, secondsLeft: held.deadline === null ? null : Math.max(0, Math.ceil((held.deadline - now) / 1000)) }
    : null;

  return {
    view,
    raise,
    keep: useCallback(() => end("keep"), [end]),
    retake: useCallback(() => end("retake"), [end]),
    settled: useCallback((lineId: string) => {
      if (last.current?.lineId === lineId) last.current = null;
    }, []),
    drop: useCallback(() => {
      heldRef.current = null;
      setHeld(null);
    }, []),
  };
}

/**
 * The lines a take of `lines[index]` might be instead, for the wrong-line check: its cue, the line
 * before it and after it in the list, the speaker's next line, and the cue of the line after it.
 */
export function nearbyLines(lines: readonly { line: Line; cue: Cue | null }[], index: number): string[] {
  const here = lines[index];
  if (!here) return [];
  const after = lines[index + 1];
  const speakersNext = lines.slice(index + 1).find((l) => l.line.characterId === here.line.characterId);
  const texts = [here.cue?.text, lines[index - 1]?.line.text, after?.line.text, after?.cue?.text, speakersNext?.line.text];
  return [...new Set(texts.filter((t): t is string => !!t && t !== here.line.text))];
}
