import { Headphones, Pause, Play } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useWakeLock } from "../../audio/wakeLock";
import { DEMO_LINES, DEMO_PART, DEMO_TITLE, hasRecording, pauseMs, spokenMs, tokenize, wordsSaid, wordStarts, type DemoLine } from "./demoScript";

export interface DemoHandle {
  play: () => void;
}

type Mode = "listen" | "pause";
/** `gap`: the pause for the listener's own line; `line`: a line playing; `rest`: the beat between lines. */
type Phase = "gap" | "line" | "rest";

interface Position {
  index: number;
  phase: Phase;
  elapsed: number;
  duration: number;
}

const REST_MS = 350;
const RECORDED = hasRecording(DEMO_LINES);

/**
 * A listen-through of a few lines of Macbeth, as Lady Macbeth hears it: each line in turn with the
 * castmate who recorded it, words lighting up as they're said, and in "Pause, then read" a pause to
 * say your own line before it plays. It opens on "Just listen": the whole scene in one pass. It
 * uses no synthesized voices: until the real-cast recording is in place (demoScript.ts) it plays
 * silently, timed by the words.
 */
export const Demo = forwardRef<DemoHandle>(function Demo(_, ref) {
  const [mode, setMode] = useState<Mode>("listen");
  const [position, setPosition] = useState<Position | null>(null);
  const [playing, setPlaying] = useState(false);
  useWakeLock(playing);
  const audio = useRef<HTMLAudioElement>(null);
  const frame = useRef(0);
  const run = useRef(0);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const stop = useCallback(() => {
    run.current++;
    cancelAnimationFrame(frame.current);
    audio.current?.pause();
    setPlaying(false);
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback((index: number, phase: Phase) => {
    const mine = run.current;
    cancelAnimationFrame(frame.current);
    if (index >= DEMO_LINES.length) {
      setPlaying(false);
      setPosition(null);
      return;
    }
    const line = DEMO_LINES[index]!;
    const after = () => {
      if (mine !== run.current) return;
      if (phase === "gap") start(index, "line");
      else if (phase === "line") start(index, "rest");
      else start(index + 1, firstPhase(DEMO_LINES[index + 1], modeRef.current));
    };
    const el = audio.current;
    if (phase === "line" && line.audio && el) {
      el.src = line.audio;
      el.onended = after;
      el.onerror = after;
      el.play().catch(after);
      const tick = () => {
        if (mine !== run.current) return;
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : spokenMs(line.text);
        setPosition({ index, phase, elapsed: el.currentTime * 1000, duration });
        frame.current = requestAnimationFrame(tick);
      };
      tick();
      return;
    }
    const duration = phase === "rest" ? REST_MS : phase === "gap" ? pauseMs(spokenMs(line.text)) : spokenMs(line.text);
    const began = performance.now();
    const tick = () => {
      if (mine !== run.current) return;
      const elapsed = Math.min(duration, performance.now() - began);
      setPosition((p) => (phase === "rest" && p ? { ...p, phase, elapsed, duration } : { index, phase, elapsed, duration }));
      if (elapsed >= duration) after();
      else frame.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const playFrom = useCallback(
    (index: number) => {
      run.current++;
      audio.current?.pause();
      setPlaying(true);
      start(index, firstPhase(DEMO_LINES[index], modeRef.current));
    },
    [start],
  );

  useImperativeHandle(ref, () => ({ play: () => playFrom(0) }), [playFrom]);

  const current = position ? DEMO_LINES[position.index] : undefined;
  const inGap = playing && position?.phase === "gap";

  return (
    <div className="mk-demo raised">
      {!RECORDED && (
        <p className="mk-demo-placeholder" data-placeholder="real-cast-recording">
          <Headphones size={18} aria-hidden="true" />
          <strong>Real-cast recording coming soon.</strong>
        </p>
      )}
      <div className="mk-demo-bar">
        <button
          type="button"
          className="mk-demo-play"
          onClick={() => (playing ? stop() : playFrom(position ? position.index : 0))}
          aria-label={playing ? "Pause the demo" : "Play the demo"}
        >
          {playing ? <Pause size={22} fill="currentColor" aria-hidden="true" /> : <Play size={22} fill="currentColor" aria-hidden="true" />}
        </button>
        <div className="mk-grow">
          <p className="eyebrow">{DEMO_TITLE}</p>
          <p className="mk-demo-you">
            You're <strong>{DEMO_PART}</strong>
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Your lines">
          <button type="button" aria-pressed={mode === "listen"} onClick={() => setMode("listen")}>
            Just listen
          </button>
          <button type="button" aria-pressed={mode === "pause"} onClick={() => setMode("pause")}>
            Pause, then read
          </button>
        </div>
      </div>
      <ol className="mk-demo-lines">
        {DEMO_LINES.map((line, i) => {
          const isCurrent = position?.index === i;
          const state = isCurrent ? "is-current" : position && i < position.index ? "is-past" : "";
          return (
            <li key={i} className={`mk-demo-line ${state} ${line.mine ? "is-mine" : ""}`}>
              <button type="button" className="mk-demo-line-btn" onClick={() => playFrom(i)} aria-label={`Play from ${line.who}: ${line.text}`}>
                <span className="mk-demo-who">
                  {line.who}
                  <span className="mk-demo-by">{isCurrent && inGap ? "Your line · say it now" : `${line.by} · recorded`}</span>
                </span>
                <LineText line={line} said={isCurrent && position ? saidCount(line, position) : null} />
              </button>
              {isCurrent && inGap && position && (
                <div className="mk-gap" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, (position.elapsed / position.duration) * 100)}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {RECORDED && <audio ref={audio} preload="auto" />}
      <p className="sr-only" aria-live="polite">
        {inGap && current ? "Your line. Say it now." : ""}
      </p>
    </div>
  );
});

function firstPhase(line: DemoLine | undefined, mode: Mode): Phase {
  return line?.mine && mode === "pause" ? "gap" : "line";
}

/** How many of the line's words have been said: none during the pause for it, all once it has played. */
function saidCount(line: DemoLine, position: Position): number {
  if (position.phase === "gap") return 0;
  if (position.phase === "rest") return Infinity;
  return wordsSaid(wordStarts(line.text, position.duration, line.wordStartsMs), position.elapsed);
}

/** The line's words: said ones in bold ink, the next one underlined, [directions] muted and never read. */
function LineText({ line, said }: { line: DemoLine; said: number | null }) {
  let word = 0;
  return (
    <span className="mk-demo-text">
      {tokenize(line.text).map((t, i) => {
        if (t.direction) return <em key={i}>{t.text}</em>;
        if (!t.word) return t.text;
        const n = word++;
        const cls = said === null ? "" : n < said ? "is-said" : n === said ? "is-next" : "is-ahead";
        return (
          <span key={i} className={cls || undefined}>
            {t.text}
          </span>
        );
      })}
    </span>
  );
}
