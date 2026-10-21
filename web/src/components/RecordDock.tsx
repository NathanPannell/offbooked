import { Mic, Settings, Square } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { markMicChecked, needsMicCheck } from "../audio/micPrefs";
import type { MicError } from "../audio/recorder";
import { type MicStatus } from "../audio/useTakeRecorder";
import { Waveform } from "../audio/Waveform";
import { formatClock } from "../lib/format";
import { MicHelp } from "./MicHelp";
import { FirstMicCheck, MicSettings } from "./MicSettings";

/**
 * The big record button pinned to the bottom of the screen, with the level meter and timer while
 * recording, and mic settings behind the gear beside it. Before the first take on a device it
 * asks for a quick mic check (or a skip) first.
 */
export function RecordDock({
  recording,
  elapsed,
  analyser,
  micStatus,
  micError,
  note,
  disabled,
  label,
  onToggle,
  onRetry,
  onDeviceChange,
  settings,
  recordedBefore = false,
}: {
  recording: boolean;
  elapsed: number;
  analyser: AnalyserNode | null;
  micStatus: MicStatus;
  micError: MicError | null;
  /** A short line above the button, only when there is something to say (a cue playing, the first take's hint). */
  note?: string;
  disabled: boolean;
  /** Accessible name for the button when not recording, e.g. "Record line 3". */
  label: string;
  onToggle: () => void;
  onRetry: () => void;
  /** A different mic was picked in mic settings. */
  onDeviceChange: (deviceId: string | null) => void;
  /** Recording options shown in mic settings. */
  settings?: ReactNode;
  /** This person already has takes of their own (another phone, another part): no mic check. */
  recordedBefore?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [micCheck, setMicCheck] = useState(needsMicCheck);
  // The mic check is once per person: someone who has recorded before skips it on any device.
  useEffect(() => {
    if (!recordedBefore || !micCheck) return;
    markMicChecked();
    setMicCheck(false);
  }, [recordedBefore, micCheck]);
  const message = micStatus === "requesting" ? "Allow the microphone when your browser asks." : note;
  // The first-run mic check is the only thing to do until it's done or skipped: the record button
  // waits behind it, so there's one filled button on screen.
  const checking = micCheck && !recording && !micError;
  const dockRef = useRef<HTMLDivElement>(null);
  useDockHeight(dockRef);

  return (
    <div className="record-dock" ref={dockRef}>
      {micError && (
        <div className="dock-help">
          <MicHelp kind={micError.kind} onRetry={onRetry} />
        </div>
      )}
      {checking && <FirstMicCheck onDone={() => setMicCheck(false)} />}
      {recording && (
        <div className="dock-meta">
          <span className="rec-dot" aria-hidden="true" />
          <Waveform analyser={analyser} active />
          <span className="dock-timer mono nums">{formatClock(elapsed)}</span>
        </div>
      )}
      {message && (
        <p className="dock-note" role="status">
          {message}
        </p>
      )}
      <div className="dock-row" hidden={checking}>
        <span className="dock-side" aria-hidden="true" />
        <button
          type="button"
          className={`record-button ${recording ? "is-recording" : ""}`}
          disabled={disabled || micStatus === "requesting"}
          onClick={onToggle}
          aria-label={recording ? "Stop recording" : label}
        >
          {recording ? <Square size={28} fill="currentColor" /> : <Mic size={32} />}
        </button>
        <span className="dock-side">
          <button
            type="button"
            className="icon-btn dock-gear"
            onClick={() => setSettingsOpen(true)}
            disabled={recording || micStatus === "requesting"}
            aria-label="Mic settings"
            title="Mic settings"
          >
            <Settings size={22} aria-hidden="true" />
          </button>
        </span>
      </div>
      <MicSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} onDeviceChange={onDeviceChange}>
        {settings}
      </MicSettings>
    </div>
  );
}

/** Publishes the dock's height as --dock-h, so the list above always scrolls clear of it (the mic check makes it taller). */
function useDockHeight(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const publish = () => root.style.setProperty("--dock-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    if (typeof ResizeObserver === "undefined") return () => root.style.removeProperty("--dock-h");
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--dock-h");
    };
  }, [ref]);
}
