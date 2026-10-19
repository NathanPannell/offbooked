import { Pause, Play } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
import { useWakeLock } from "../../audio/wakeLock";
import { DEMO_LINES, DEMO_TITLE, holdMs } from "./demoScript";

export interface DemoHandle {
  play: () => void;
}

const VOICE_PITCH: Record<string, number> = { Claudius: 0.8, Gertrude: 1.15, Hamlet: 1 };

function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * A playable run-through of a few lines. Lines are spoken by the browser's own voices (the same idea
 * as the app's TTS fill-in); in "my part" mode Hamlet's lines become timed gaps for you to speak.
 * Without speech it steps through the lines silently.
 */
export const Demo = forwardRef<DemoHandle>(function Demo(_, ref) {
  const [mode, setMode] = useState<"full" | "mine">("mine");
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  useWakeLock(playing);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const stop = useCallback(() => {
    run.current++;
    if (timer.current) clearTimeout(timer.current);
    if (speechAvailable()) window.speechSynthesis.cancel();
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const playFrom = useCallback((start: number) => {
    const mine = ++run.current;
    if (timer.current) clearTimeout(timer.current);
    if (speechAvailable()) window.speechSynthesis.cancel();
    setPlaying(true);
    const voices = speechAvailable() ? window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en")) : [];

    const step = (i: number) => {
      if (mine !== run.current) return;
      if (i >= DEMO_LINES.length) {
        setPlaying(false);
        setIndex(-1);
        return;
      }
      setIndex(i);
      const line = DEMO_LINES[i]!;
      const next = () => {
        if (mine !== run.current) return;
        timer.current = setTimeout(() => step(i + 1), 350);
      };
      const gap = line.source === "you" && modeRef.current === "mine";
      if (gap || !speechAvailable()) {
        timer.current = setTimeout(next, holdMs(line.text) * (gap ? 1.2 : 1));
        return;
      }
      const utterance = new SpeechSynthesisUtterance(line.text.replace(/\n/g, " "));
      utterance.pitch = VOICE_PITCH[line.who] ?? 1;
      utterance.rate = 0.95;
      const voiceIndex = Object.keys(VOICE_PITCH).indexOf(line.who);
      if (voices.length > 1) utterance.voice = voices[voiceIndex % voices.length]!;
      // Some browsers never fire `end`: fall back to a generous timer.
      const fallback = setTimeout(next, holdMs(line.text) * 2.2);
      utterance.onend = () => {
        clearTimeout(fallback);
        next();
      };
      utterance.onerror = () => {
        clearTimeout(fallback);
        timer.current = setTimeout(next, holdMs(line.text));
      };
      window.speechSynthesis.speak(utterance);
    };
    step(start);
  }, []);

  useImperativeHandle(ref, () => ({ play: () => playFrom(0) }), [playFrom]);

  const current = DEMO_LINES[index];
  const inGap = playing && current?.source === "you" && mode === "mine";

  return (
    <div className="demo raised">
      <div className="demo-bar">
        <button
          type="button"
          className="demo-play"
          onClick={() => (playing ? stop() : playFrom(index >= 0 ? index : 0))}
          aria-label={playing ? "Pause the demo" : "Play the demo"}
        >
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
        </button>
        <div className="grow">
          <p className="eyebrow">{DEMO_TITLE}</p>
          <p className="demo-you">
            You're <strong>Hamlet</strong>
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Playback">
          <button type="button" aria-pressed={mode === "full"} onClick={() => setMode("full")}>
            Full cast
          </button>
          <button type="button" aria-pressed={mode === "mine"} onClick={() => setMode("mine")}>
            My part
          </button>
        </div>
      </div>
      <ol className="demo-lines" aria-live="off">
        {DEMO_LINES.map((line, i) => {
          const state = i === index ? "is-current" : i < index ? "is-past" : "";
          const you = line.source === "you";
          return (
            <li key={i} className={`demo-line ${state} ${you ? "is-you" : ""}`}>
              <button type="button" className="demo-line-btn" onClick={() => playFrom(i)}>
                <span className="demo-who">
                  {line.who}
                  {you ? (
                    <span className="your-line">your line</span>
                  ) : (
                    <span className={`tag tag-${line.source === "actor" ? "actor" : line.source}`}>{line.by}</span>
                  )}
                </span>
                <span className="demo-text">{line.text}</span>
              </button>
              {i === index && inGap && (
                <div className="gap-meter" style={{ "--gap-ms": `${holdMs(line.text) * 1.2}ms` } as CSSProperties} key={`${index}-gap`} aria-hidden="true">
                  <span />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <p className="demo-note small muted">
        {mode === "mine"
          ? "In “My part” the play pauses for your lines, so you can say them out loud."
          : "Voices here come from your browser. In Offbooked they're your cast's own recordings."}
      </p>
      <p className="sr-only" aria-live="polite">
        {inGap ? "Your line. Say it now." : ""}
      </p>
    </div>
  );
});
