import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { SpokenSegment } from "../api/types";
import type { PlayerEngine } from "./engine";
import { keepInView } from "./follow";
import { lineTokens, wordAt, wordTimes, type WordTime } from "./words";

interface Props {
  text: string;
  kind: "dialogue" | "stage_direction";
  /** The line's place in the play queue. */
  index: number;
  engine: PlayerEngine;
  audio: HTMLAudioElement;
  /** Whether to scroll the current word into view now (following, and playing). */
  shouldFollow: () => boolean;
  root: RefObject<HTMLElement | null>;
}

/**
 * The line being played, word by word: said words in ink, the current one marked, the rest muted.
 * Follows the audio's media time (so any speed works) on each animation frame, with timeupdate as a
 * fallback when frames are throttled. Only this one line is split into word spans.
 */
export function LiveText({ text, kind, index, engine, audio, shouldFollow, root }: Props) {
  const tokens = useMemo(() => lineTokens(text, kind), [text, kind]);
  const [current, setCurrent] = useState(-1);
  const wordEls = useRef<(HTMLSpanElement | null)[]>([]);
  const timed = useRef<{ kind: string; durationMs: number; segments?: SpokenSegment[]; times: WordTime[] } | null>(null);

  useEffect(() => {
    timed.current = null;
    const tick = () => {
      const pos = engine.position();
      let word = -1;
      if (pos && pos.index === index) {
        if (pos.kind === "after") word = tokens.length;
        else if (pos.kind === "clip" || pos.kind === "gap") {
          const t = timed.current;
          if (!t || t.kind !== pos.kind || t.durationMs !== pos.durationMs || t.segments !== pos.segments) {
            const times = wordTimes(tokens, { durationMs: pos.durationMs, segments: pos.kind === "clip" ? pos.segments : undefined });
            timed.current = { kind: pos.kind, durationMs: pos.durationMs, segments: pos.segments, times };
          }
          word = wordAt(timed.current!.times, pos.timeMs);
        }
      }
      setCurrent(word);
    };
    let frame = 0;
    const loop = () => {
      tick();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("seeked", tick);
    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("timeupdate", tick);
      audio.removeEventListener("seeked", tick);
    };
  }, [engine, audio, index, tokens]);

  // Follow the word as it moves: the page only moves when the word starts a new row (follow.ts).
  useEffect(() => {
    const el = wordEls.current[current];
    if (el && shouldFollow()) keepInView(el, root.current);
  }, [current, shouldFollow, root]);

  const children: ReactNode[] = [];
  let at = 0;
  tokens.forEach((t, i) => {
    if (t.start > at) children.push(text.slice(at, t.start));
    const state = i < current ? "is-said" : i === current ? "is-now" : "";
    const dir = kind === "dialogue" && t.narrator ? "rw-dir" : "";
    children.push(
      <span
        key={i}
        ref={(el) => {
          wordEls.current[i] = el;
        }}
        className={`rw ${state} ${dir}`}
      >
        {text.slice(t.start, t.end)}
      </span>,
    );
    at = t.end;
  });
  if (at < text.length) children.push(text.slice(at));

  return <span className="lyric-text is-live">{children}</span>;
}
