import { Mic, Square } from "lucide-react";
import type { MicError } from "../audio/recorder";
import { MAX_TAKE_MS, type MicStatus } from "../audio/useTakeRecorder";
import { Waveform } from "../audio/Waveform";
import { formatClock } from "../lib/format";
import { MicHelp } from "./MicHelp";

/** The big record button pinned to the bottom of the screen, with the level meter and timer. */
export function RecordDock({
  recording,
  elapsed,
  analyser,
  micStatus,
  micError,
  hint,
  disabled,
  label,
  onToggle,
  onRetry,
}: {
  recording: boolean;
  elapsed: number;
  analyser: AnalyserNode | null;
  micStatus: MicStatus;
  micError: MicError | null;
  /** What to do next, when not recording. */
  hint: string;
  disabled: boolean;
  /** Accessible name for the button when not recording, e.g. "Record line 3". */
  label: string;
  onToggle: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="record-dock">
      {micError && (
        <div className="dock-help">
          <MicHelp kind={micError.kind} onRetry={onRetry} />
        </div>
      )}
      {recording ? (
        <div className="dock-meta">
          <span className="rec-dot" aria-hidden="true" />
          <Waveform analyser={analyser} active />
          <span className="dock-timer mono nums">
            {formatClock(elapsed)} <span className="muted">/ {formatClock(MAX_TAKE_MS)}</span>
          </span>
        </div>
      ) : (
        <p className="dock-hint">
          {micStatus === "requesting"
            ? "Allow the microphone when your browser asks."
            : micStatus === "idle" && !micError
              ? "Tap to record. Your browser will ask for the mic once."
              : hint}
        </p>
      )}
      <button
        type="button"
        className={`record-button ${recording ? "is-recording" : ""}`}
        disabled={disabled || micStatus === "requesting"}
        onClick={onToggle}
        aria-label={recording ? "Stop recording" : label}
      >
        {recording ? <Square size={28} fill="currentColor" /> : <Mic size={32} />}
      </button>
    </div>
  );
}
