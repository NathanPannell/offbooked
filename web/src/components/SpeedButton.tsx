import { useState } from "react";
import { formatSpeed, setSpeed, speedChoices, usePlaybackSpeed } from "../audio/speed";
import { Dialog } from "./Dialog";

/**
 * The playback speed: a labelled button ("Speed 1×") that opens a sheet with every speed at once,
 * 0.5× to 4×; a pick plays at it straight away and closes the sheet. One speed for every player,
 * so every button shows the same. `note` says what the speed doesn't change (the listener's own lines).
 */
export function SpeedButton({ note, className = "" }: { note?: string; className?: string }) {
  const speed = usePlaybackSpeed();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`speed-btn${speed !== 1 ? " is-changed" : ""}${className ? ` ${className}` : ""}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span className="speed-btn-label">Speed</span> <span className="speed-btn-value nums">{formatSpeed(speed)}</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Playback speed">
        <div className="speed-options" role="group" aria-label="Speeds">
          {speedChoices(speed).map((choice) => (
            <button
              key={choice.speed}
              type="button"
              className={`speed-option${choice.selected ? " is-selected" : ""}`}
              aria-pressed={choice.selected}
              onClick={() => {
                setSpeed(choice.speed);
                setOpen(false);
              }}
            >
              <span className="speed-option-value nums">{choice.label}</span>
              {choice.hint && <span className="speed-option-hint">{choice.hint}</span>}
            </button>
          ))}
        </div>
        {note && <p className="speed-note">{note}</p>}
        <p className="small muted speed-remembered">Remembered on this device, for every recording you play.</p>
      </Dialog>
    </>
  );
}
