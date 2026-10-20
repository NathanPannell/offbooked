import { Check, Mic, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chooseMic, markMicChecked, micOptions, rememberedMic, type MicOption } from "../audio/micPrefs";
import { listenForCheck, MIC_CHECK_MAX_MS, recordSample, type Listened } from "../audio/micTest";
import { micConstraints, MicError, MicSession } from "../audio/recorder";
import { silenceUrl } from "../player/silence";
import { Waveform, type WaveTrace } from "../audio/Waveform";
import { Dialog } from "./Dialog";
import { MicHelp } from "./MicHelp";

export type MicTestState =
  | { status: "idle" }
  | { status: "listening" }
  | { status: "playing"; clip: Listened }
  | { status: "heard"; clip: Listened }
  | { status: "error"; error: MicError };

/**
 * The mic check: one tap opens the mic and it listens, with a live waveform, until it has heard
 * someone speak and then stop (or a few seconds pass); then it plays the clip straight back by
 * itself, the waveform filling as it plays. Its own short mic session, closed as soon as the clip
 * is in, so it never holds the mic open.
 */
function useMicTest() {
  const [state, setState] = useState<MicTestState>({ status: "idle" });
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const mic = useRef<MicSession | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const alive = useRef(true);
  const listening = useRef<AbortController | null>(null);

  const cleanUp = useCallback(() => {
    listening.current?.abort();
    listening.current = null;
    mic.current?.close();
    mic.current = null;
    audio.current?.pause();
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cleanUp();
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, [cleanUp]);

  const play = useCallback((src: string, clip: Listened) => {
    const a = (audio.current ??= new Audio());
    a.src = src;
    a.currentTime = 0;
    setState({ status: "playing", clip });
    const done = () => alive.current && setState({ status: "heard", clip });
    a.onended = done;
    a.onerror = done;
    void a.play().catch(done);
  }, []);

  /** Call from a tap: the browser may ask for the mic, and the playback needs the tap too. */
  const run = useCallback(async () => {
    cleanUp();
    // iOS only lets an element play sound once it has played from a tap, and the clip arrives seconds
    // later: start the element on a moment of silence now, then play the clip on it.
    const a = (audio.current ??= new Audio());
    a.onended = null;
    a.onerror = null;
    a.src = silenceUrl(50);
    void a.play().catch(() => {});
    const session = new MicSession(micConstraints(rememberedMic()));
    mic.current = session;
    const stop = new AbortController();
    listening.current = stop;
    setState({ status: "listening" });
    let heard: Listened = { heardVoice: false, durationMs: 0, levels: [] };
    try {
      const blob = await recordSample(session, MIC_CHECK_MAX_MS, {
        onListening: () => setAnalyser(session.analyser),
        wait: async (ms) => {
          heard = await listenForCheck(session.analyser, ms, stop.signal);
        },
      });
      if (!alive.current || mic.current !== session) return;
      mic.current = null;
      setAnalyser(null);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      play(url.current, heard);
    } catch (err) {
      if (!alive.current || mic.current !== session) return;
      mic.current = null;
      setAnalyser(null);
      setState({ status: "error", error: err as MicError });
    }
  }, [cleanUp, play]);

  /** Back to the start, the mic closed. */
  const reset = useCallback(() => {
    cleanUp();
    setAnalyser(null);
    setState({ status: "idle" });
  }, [cleanUp]);

  return { state, analyser, run, reset, audio };
}

/**
 * The mic check, here and in mic settings: tap, say a line, hear it back. While it listens there's a
 * big live waveform; the clip then plays back by itself, drawn whole and filling as it plays. After
 * that, `doneAction` (the one filled button) and a quiet "Try again". `onHeard` says whether the
 * playback has been heard (false again while a new check runs).
 */
export interface MicTestProps {
  startLabel?: string;
  /** The start button is the screen's one filled action (the first-run check, with the record button hidden). */
  primary?: boolean;
  /** A line above the start button. */
  intro?: ReactNode;
  onHeard?: (heard: boolean) => void;
  doneAction?: (reset: () => void) => ReactNode;
  /** Shown in every state, the mic's errors included (e.g. the first run's Skip, so nobody is ever stuck). */
  aside?: ReactNode;
}

export function MicTest({ onHeard, ...props }: MicTestProps) {
  const { state, analyser, run, reset, audio } = useMicTest();
  const heard = state.status === "heard";
  const onHeardRef = useRef(onHeard);
  onHeardRef.current = onHeard;
  useEffect(() => {
    onHeardRef.current?.(heard);
  }, [heard]);

  const clip = state.status === "playing" || state.status === "heard" ? state.clip : null;
  const trace = useMemo<WaveTrace | undefined>(() => {
    if (!clip) return undefined;
    if (state.status === "heard") return { levels: clip.levels, progress: () => 1 };
    // The recorder's clips often don't say their length, so the progress comes from how long it listened.
    return { levels: clip.levels, progress: () => ((audio.current?.currentTime ?? 0) * 1000) / Math.max(1, clip.durationMs) };
  }, [clip, state.status, audio]);

  return <MicTestView {...props} state={state} analyser={analyser} trace={trace} onRun={() => void run()} onReset={reset} />;
}

/** What the mic check shows in each state (MicTest runs it). */
export function MicTestView({
  state,
  analyser,
  trace,
  onRun,
  onReset,
  startLabel = "Test my mic",
  primary = false,
  intro,
  doneAction,
  aside,
}: Omit<MicTestProps, "onHeard"> & {
  state: MicTestState;
  analyser: AnalyserNode | null;
  trace?: WaveTrace;
  onRun: () => void;
  onReset: () => void;
}) {
  if (state.status === "error") {
    return (
      <div className="mic-test is-error">
        <MicHelp kind={state.error.kind} onRetry={onRun} />
        {aside && <div className="mic-test-row">{aside}</div>}
      </div>
    );
  }
  const heard = state.status === "heard";
  const clip = state.status === "playing" || heard ? state.clip : null;
  const status =
    state.status === "listening" ? "Listening… say a line" : state.status === "playing" ? "Playing it back" : heard ? "Did you hear yourself?" : null;
  return (
    <div className={`mic-test is-${state.status}`}>
      {state.status === "idle" ? (
        <>
          {intro}
          <div className="mic-test-row">
            <button type="button" className={`btn ${primary ? "btn-primary" : "btn-secondary"}`} onClick={onRun}>
              <Mic size={18} aria-hidden="true" /> {startLabel}
            </button>
            {aside}
          </div>
        </>
      ) : (
        <>
          <div className="mic-test-stage">
            <span className="mic-test-ring" aria-hidden="true">
              <Mic size={20} />
            </span>
            <Waveform analyser={analyser} active={state.status === "listening"} trace={trace} className="waveform-big" />
          </div>
          <div className="mic-test-row">
            <p className="mic-test-status" aria-live="polite">
              {status}
            </p>
            {heard ? (
              <span className="mic-test-actions">
                {aside}
                <button type="button" className="btn btn-ghost btn-sm" onClick={onRun}>
                  <RotateCcw size={15} aria-hidden="true" /> Try again
                </button>
                {doneAction?.(onReset)}
              </span>
            ) : (
              aside
            )}
          </div>
          {heard && clip && !clip.heardVoice && (
            <p className="mic-test-quiet small" role="status">
              That was very quiet. Check the mic isn't muted or covered, then try again.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The mics this browser has, refreshed when one is plugged in or the mic is first allowed. */
function useMicOptions(open: boolean) {
  const [options, setOptions] = useState<MicOption[]>([{ id: "", label: "Default microphone" }]);
  const refresh = useCallback(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;
    void devices.enumerateDevices().then(
      (list) => setOptions(micOptions(list)),
      () => {},
    );
  }, []);
  useEffect(() => {
    if (!open) return;
    refresh();
    const devices = navigator.mediaDevices;
    devices?.addEventListener?.("devicechange", refresh);
    return () => devices?.removeEventListener?.("devicechange", refresh);
  }, [open, refresh]);
  return { options, refresh };
}

/**
 * Mic settings, behind the gear beside the record button: a mic test, which mic to use (remembered
 * on this device) and the recording options passed in as children.
 */
export function MicSettings({
  open,
  onClose,
  onDeviceChange,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onDeviceChange: (deviceId: string | null) => void;
  children?: ReactNode;
}) {
  const { options, refresh } = useMicOptions(open);
  const [device, setDevice] = useState(() => rememberedMic() ?? "");
  const [checked, setChecked] = useState(false);
  const selected = chooseMic(options, device);

  return (
    <Dialog open={open} onClose={onClose} title="Mic settings">
      <div className="mic-settings">
        <label className="field">
          <span>Microphone</span>
          <select
            className="input"
            value={selected}
            onChange={(e) => {
              setDevice(e.target.value);
              onDeviceChange(e.target.value || null);
            }}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {options.length === 1 ? (
            <span className="field-hint">Other mics show here once you've allowed the mic. Test it below.</span>
          ) : (
            options.slice(1).every((o) => /^Microphone \d+$/.test(o.label)) && <span className="field-hint">Names show once you've allowed the mic.</span>
          )}
        </label>
        <section className="stack mic-settings-test">
          <h3 className="eyebrow">Test your mic</h3>
          <MicTest
            intro={
              checked ? (
                <p className="mic-test-ok small">
                  <Check size={15} aria-hidden="true" /> Your mic works.
                </p>
              ) : undefined
            }
            onHeard={(heard) => heard && refresh()}
            doneAction={(reset) => (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setChecked(true);
                  reset();
                }}
              >
                Sounds good
              </button>
            )}
          />
        </section>
        {children && <div className="mic-settings-options">{children}</div>}
      </div>
    </Dialog>
  );
}

/** Before the very first take on a device: the mic check in place of the record button, with Skip. */
export function FirstMicCheck({ onDone }: { onDone: () => void }) {
  const finish = () => {
    markMicChecked();
    onDone();
  };
  const skip = (
    <button type="button" className="btn btn-ghost btn-sm mic-test-skip" onClick={finish}>
      Skip
    </button>
  );
  return (
    <section className="first-mic-check" aria-label="Mic check">
      <MicTest
        startLabel="Check my mic"
        primary
        intro={
          <p className="first-mic-check-intro">
            <strong>Let's check your mic.</strong> Say a line out loud and you'll hear it straight back.
          </p>
        }
        aside={skip}
        doneAction={() => (
          <button type="button" className="btn btn-primary btn-sm" onClick={finish}>
            Sounds good
          </button>
        )}
      />
    </section>
  );
}
