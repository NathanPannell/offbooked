import { Mic, Settings, Square } from "lucide-react";
import { useState, type ReactNode } from "react";
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
 * offers a quick mic check.
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
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [micCheck, setMicCheck] = useState(needsMicCheck);
  const message = micStatus === "requesting" ? "Allow the microphone when your browser asks." : note;

  return (
    <div className="record-dock">
      {micError && (
        <div className="dock-help">
          <MicHelp kind={micError.kind} onRetry={onRetry} />
        </div>
      )}
      {micCheck && !recording && !micError && <FirstMicCheck onDone={() => setMicCheck(false)} />}
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
      <div className="dock-row">
        <span className="dock-side" aria-hidden="true" />
        <button
          type="button"
          className={`record-button ${recording ? "is-recording" : ""}`}
          disabled={disabled || micStatus === "requesting"}
          onClick={() => {
            // Recording straight away counts as having checked the mic.
            if (micCheck) {
              markMicChecked();
              setMicCheck(false);
            }
            onToggle();
          }}
          aria-label={recording ? "Stop recording" : label}
        >
          {recording ? <Square size={28} fill="currentColor" /> : <Mic size={32} />}
        </button>
        <span className="dock-side">
          <button
            type="button"
            className="icon-btn dock-gear"
            onClick={() => setSettingsOpen(true)}
            disabled={recording}
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
