import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlayerEngine } from "./engine";
import { lineTokens, wordAt, wordTimes, type ClipTimings, type WordTime } from "./words";

/** Character offsets of a line's cue (its last sentence, underlined), or null. */
export type CueSpan = { start: number; end: number } | null;

interface Props {
  text: string;
  kind: "dialogue" | "stage_direction";
  /** The line's place in the play queue. */
  index: number;
  engine: PlayerEngine;
  audio: HTMLAudioElement;
  /** The listener's cue in this line, underlined. */
  cue: CueSpan;
  /** Called each time a new word starts, for following it. */
  onAdvance: () => void;
}

/** `text` with its cue wrapped in `.lyric-cue`; `render` gives the nodes for a stretch of it. */
function withCue(text: string, cue: CueSpan, render: (from: number, to: number) => ReactNode[]): ReactNode[] {
  if (!cue || cue.end <= cue.start) return render(0, text.length);
  return [
    ...render(0, cue.start),
    <span key="cue" className="lyric-cue">
      {render(cue.start, cue.end)}
    </span>,
    ...render(cue.end, text.length),
  ];
}

/** A line that isn't playing: its text, with the listener's cue underlined. */
export function LineText({ text, cue }: { text: string; cue: CueSpan }) {
  return <span className="lyric-text">{withCue(text, cue, (from, to) => (to > from ? [text.slice(from, to)] : []))}</span>;
}

/**
 * The line being played, word by word: words already said in bold, the next one to be said
 * underlined, the rest muted. Follows the audio's media time (so any speed works) on each
 * animation frame, with timeupdate as a fallback when frames are throttled. Only this one line is
 * split into word spans.
 */
export function LiveText({ text, kind, index, engine, audio, cue, onAdvance }: Props) {
  const tokens = useMemo(() => lineTokens(text, kind), [text, kind]);
  const [current, setCurrent] = useState(-1);
  const timed = useRef<{ key: unknown[]; times: WordTime[] } | null>(null);

  useEffect(() => {
    timed.current = null;
    const tick = () => {
      const pos = engine.position();
      let word = -1;
      if (pos && pos.index === index) {
        if (pos.kind === "after") word = tokens.length;
        else if (pos.kind === "clip" || pos.kind === "gap") {
          const clip = pos.kind === "clip";
          const timings: ClipTimings = {
            durationMs: pos.durationMs,
            segments: clip ? pos.segments : undefined,
            wordStartsMs: clip ? pos.wordStartsMs : undefined,
            speech: clip ? pos.speech : undefined,
          };
          const key = [pos.kind, timings.durationMs, timings.segments, timings.wordStartsMs, timings.speech];
          const t = timed.current;
          if (!t || key.some((k, i) => k !== t.key[i])) timed.current = { key, times: wordTimes(tokens, timings) };
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

  // Follow the words as they start (follow.ts decides whether the page moves).
  useEffect(() => {
    if (current >= 0 && current < tokens.length) onAdvance();
  }, [current, tokens.length, onAdvance]);

  // The next word to be said: the first spoken one after the current word.
  let next = -1;
  for (let i = current + 1; i < tokens.length; i++) {
    if (tokens[i]!.pieces.length) {
      next = i;
      break;
    }
  }

  const render = (from: number, to: number) => {
    const out: ReactNode[] = [];
    let at = from;
    tokens.forEach((t, i) => {
      if (t.start < from || t.end > to) return;
      if (t.start > at) out.push(text.slice(at, t.start));
      const state = [i <= current && "is-said", i === current && "is-now", i === next && "is-next", kind === "dialogue" && t.narrator && "rw-dir"]
        .filter(Boolean)
        .join(" ");
      out.push(
        <span key={i} className={`rw ${state}`}>
          {text.slice(t.start, t.end)}
        </span>,
      );
      at = t.end;
    });
    if (at < to) out.push(text.slice(at, to));
    return out;
  };

  return <span className="lyric-text is-live">{withCue(text, cue, render)}</span>;
}
