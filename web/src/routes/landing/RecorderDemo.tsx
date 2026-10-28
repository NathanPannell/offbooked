import { Check, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_PART, tokenize } from "./demoScript";
import { RECORDER_LINES, recorderAt } from "./recorderScript";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * A walkthrough of hands-free recording: Lady Macbeth's lines, each heard word by word, and the
 * next line recording by itself as soon as one ends. It starts once it scrolls into view (not under
 * reduced motion) and can be paused, resumed and played again. Silent: nothing is recorded.
 */
export function RecorderDemo() {
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const autoplayed = useRef(false);

  const pause = useCallback(() => {
    cancelAnimationFrame(frame.current);
    setPlaying(false);
  }, []);

  const play = useCallback((from: number) => {
    cancelAnimationFrame(frame.current);
    setPlaying(true);
    // Frame by frame, at most 100 ms a frame, so a tab left in the background (no frames) carries
    // on where it was instead of jumping ahead.
    let ms = from;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      ms += Math.min(100, now - last);
      last = now;
      setElapsed(ms);
      if (recorderAt(ms).phase === "wrapped") setPlaying(false);
      else frame.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Start once, when most of it is on screen.
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || autoplayed.current) return;
        autoplayed.current = true;
        play(0);
      },
      { threshold: 0.6 },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [play]);

  const at = recorderAt(elapsed);
  const wrapped = at.phase === "wrapped";
  const total = RECORDER_LINES.length;
  const line = RECORDER_LINES[at.index];
  const prev = RECORDER_LINES[at.index - 1];
  const next = RECORDER_LINES[at.index + 1];
  const speaking = playing && at.phase === "speaking";
  const status =
    !playing && !wrapped ? (elapsed > 0 ? "Paused" : "Press play to watch") : at.phase === "ending" ? "Got it. Next line…" : "Recording · hands-free";

  const toggle = () => {
    autoplayed.current = true;
    if (wrapped) play(0);
    else if (playing) pause();
    else play(elapsed);
  };

  return (
    <div className="mk-rec raised" ref={root} data-phase={at.phase}>
      <div className="mk-rec-head">
        <p className="mk-rec-for">
          Recording for <strong>{DEMO_PART}</strong>
        </p>
        <div className="progress mk-rec-progress" aria-hidden="true">
          <span style={{ width: `${(at.recorded / total) * 100}%` }} />
        </div>
        <p className="mk-rec-count small muted" aria-live="polite">
          {at.recorded} of {total} recorded
        </p>
      </div>

      <div className="mk-rec-stage">
        {wrapped || !line ? (
          <div className="mk-rec-wrapped">
            <p className="mk-rec-wrapped-title">You're wrapped</p>
            <p className="small muted">Every line is in. No taps between takes.</p>
          </div>
        ) : (
          <>
            {prev && (
              <div className="mk-rec-card is-done" key={`done-${at.index}`}>
                <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                <span className="mk-rec-done-text">{prev.text}</span>
              </div>
            )}
            <div className={`mk-rec-card is-current ${speaking ? "is-recording" : ""}`} key={`line-${at.index}`}>
              <div className="mk-rec-cue">
                <span className="mk-rec-cue-who">{line.cueWho}</span>
                <span className="mk-rec-cue-text">{line.cue}</span>
              </div>
              <p className="mk-rec-line">
                <RecordingWords text={line.text} heard={at.heard} live={playing || elapsed > 0} />
              </p>
            </div>
            {next && (
              <div className="mk-rec-card is-next" aria-hidden="true">
                <span>{next.text}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mk-rec-dock">
        <button
          type="button"
          className={`mk-rec-btn ${playing ? "is-on" : ""}`}
          onClick={toggle}
          aria-label={wrapped ? "Play the recording demo again" : playing ? "Pause the recording demo" : "Play the recording demo"}
        >
          {wrapped ? (
            <RotateCcw size={20} aria-hidden="true" />
          ) : playing ? (
            <Pause size={20} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play size={20} fill="currentColor" aria-hidden="true" />
          )}
        </button>
        <span className="mk-rec-status">{wrapped ? "Play again" : status}</span>
        <span className={`mk-rec-level ${speaking ? "is-live" : ""}`} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

/** The line, its heard words bold and underlined in ink and the next one underlined. */
function RecordingWords({ text, heard, live }: { text: string; heard: number; live: boolean }) {
  let word = 0;
  return tokenize(text).map((t, i) => {
    if (!t.word) return t.direction ? <em key={i}>{t.text}</em> : t.text;
    const n = word++;
    const cls = !live ? undefined : n < heard ? "is-heard" : n === heard ? "is-next" : undefined;
    return (
      <span key={i} className={cls}>
        {t.text}
      </span>
    );
  });
}
