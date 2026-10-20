import { useCallback, useState, type ReactNode } from "react";
import { readStorage, writeStorage } from "../lib/storage";

// The recording options both recorders share (the cast's and the director's studio), remembered
// per device, and the one line shown on the device's first take.

export const AUTO_ADVANCE_KEY = "offbooked.autoAdvance";
export const KEEP_RECORDING_KEY = "offbooked.keepRecording";
export const FIRST_TAKE_HINT = "Moves to the next line when you finish. Change this in mic settings.";

/** A yes/no setting kept in localStorage ("1"/"0"); without storage it lasts the visit. */
export function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    const stored = readStorage(key);
    return stored === null ? fallback : stored === "1";
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStorage(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set] as const;
}

/** Stop and move on when the line is said (on by default), and record the next one straight away (off). */
export function useRecordOptions() {
  const [autoAdvance, setAutoAdvance] = useStoredFlag(AUTO_ADVANCE_KEY, true);
  const [keepRecording, setKeepRecording] = useStoredFlag(KEEP_RECORDING_KEY, false);
  return { autoAdvance, setAutoAdvance, keepRecording, setKeepRecording };
}

/** The options in mic settings, with any the screen adds after them. */
export function RecordOptions({ options, children }: { options: ReturnType<typeof useRecordOptions>; children?: ReactNode }) {
  const { autoAdvance, setAutoAdvance, keepRecording, setKeepRecording } = options;
  return (
    <>
      <h3 className="eyebrow">While you record</h3>
      <label className="checkbox">
        <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} />
        Go to the next line when I finish
      </label>
      <label className={`checkbox${autoAdvance ? "" : " is-off"}`}>
        <input type="checkbox" checked={keepRecording} disabled={!autoAdvance} onChange={(e) => setKeepRecording(e.target.checked)} />
        Keep recording the next line
      </label>
      {children}
    </>
  );
}
