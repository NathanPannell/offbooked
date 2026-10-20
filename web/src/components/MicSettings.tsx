import { Mic, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { chooseMic, markMicChecked, micOptions, rememberedMic, type MicOption } from "../audio/micPrefs";
import { recordSample } from "../audio/micTest";
import { micConstraints, MicError, MicSession } from "../audio/recorder";
import { silenceUrl } from "../player/silence";
import { Waveform } from "../audio/Waveform";
import { Dialog } from "./Dialog";
import { MicHelp } from "./MicHelp";

const TEST_MS = 3000;

type TestState = { status: "idle" } | { status: "listening" } | { status: "playing" } | { status: "heard"; url: string } | { status: "error"; error: MicError };

/**
 * A mic test: record a few seconds on the chosen mic, then play it straight back. Its own short
 * mic session, closed as soon as the clip is in, so it never holds the mic open.
 */
function useMicTest() {
  const [state, setState] = useState<TestState>({ status: "idle" });
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const mic = useRef<MicSession | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const alive = useRef(true);

  const cleanUp = useCallback(() => {
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

  const play = useCallback((clip: string) => {
    const a = (audio.current ??= new Audio());
    a.src = clip;
    a.currentTime = 0;
    setState({ status: "playing" });
    const done = () => alive.current && setState({ status: "heard", url: clip });
    a.onended = done;
    a.onerror = done;
    void a.play().catch(done);
  }, []);

  /** Call from a tap: the browser may ask for the mic. */
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
    setState({ status: "listening" });
    try {
      const blob = await recordSample(session, TEST_MS, { onListening: () => setAnalyser(session.analyser) });
      if (!alive.current || mic.current !== session) return;
      mic.current = null;
      setAnalyser(null);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      play(url.current);
    } catch (err) {
      if (!alive.current || mic.current !== session) return;
      mic.current = null;
      setAnalyser(null);
      setState({ status: "error", error: err as MicError });
    }
  }, [cleanUp, play]);

  return { state, analyser, run, play };
}

/**
 * Record a few seconds, then hear them back. `onHeard` says whether the playback has been heard
 * (false again while a new test runs or after it fails); `doneAction` sits beside "Did you hear
 * yourself?".
 */
export function MicTest({
  startLabel = "Test my mic",
  primary = false,
  onHeard,
  doneAction,
}: {
  startLabel?: string;
  /** The start button is the screen's one filled action (the first-run check, with the record button hidden). */
  primary?: boolean;
  onHeard?: (heard: boolean) => void;
  doneAction?: ReactNode;
}) {
  const { state, analyser, run, play } = useMicTest();
  const heard = state.status === "heard";
  const onHeardRef = useRef(onHeard);
  onHeardRef.current = onHeard;
  useEffect(() => {
    onHeardRef.current?.(heard);
  }, [heard]);

  if (state.status === "error") return <MicHelp kind={state.error.kind} onRetry={() => void run()} />;
  return (
    <div className="mic-test" aria-live="polite">
      {state.status === "idle" && (
        <button type="button" className={`btn ${primary ? "btn-primary" : "btn-secondary"}`} onClick={() => void run()}>
          <Mic size={18} aria-hidden="true" /> {startLabel}
        </button>
      )}
      {state.status === "listening" && (
        <div className="mic-test-live">
          <span className="rec-dot" aria-hidden="true" />
          <span className="small">Listening… say anything</span>
          <Waveform analyser={analyser} active />
        </div>
      )}
      {state.status === "playing" && <p className="small mic-test-live">Playing it back…</p>}
      {heard && (
        <div className="mic-test-heard">
          <p className="mic-test-question">
            <span className="small grow">Did you hear yourself?</span>
            {doneAction}
          </p>
          <div className="mic-test-again">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => play(state.url)}>
              <Play size={15} aria-hidden="true" /> Play again
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run()}>
              <RotateCcw size={15} aria-hidden="true" /> Test again
            </button>
          </div>
        </div>
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
          <MicTest onHeard={(heard) => heard && refresh()} />
        </section>
        {children && <div className="mic-settings-options">{children}</div>}
      </div>
    </Dialog>
  );
}

/** Before the very first take on a device: a quick mic check, with Skip. */
export function FirstMicCheck({ onDone }: { onDone: () => void }) {
  const [heard, setHeard] = useState(false);
  const finish = () => {
    markMicChecked();
    onDone();
  };
  return (
    <section className="first-mic-check" aria-labelledby="first-mic-check-title">
      <p id="first-mic-check-title">
        <strong>Let's check your mic:</strong> say anything, then hear it back.
      </p>
      <div className="first-mic-check-row">
        <MicTest
          startLabel="Check my mic"
          primary
          onHeard={setHeard}
          doneAction={
            <button type="button" className="btn btn-primary btn-sm" onClick={finish}>
              Sounds good
            </button>
          }
        />
        {!heard && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={finish}>
            Skip
          </button>
        )}
      </div>
    </section>
  );
}
