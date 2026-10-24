import { useCallback, useState, type ReactNode } from "react";
import { readStorage, writeStorage } from "../lib/storage";

// The recording options both recorders share (the cast's and the director's studio), remembered
// per device, and the one line shown on the device's first take.

export const AUTO_ADVANCE_KEY = "offbooked.autoAdvance";
/**
 * "Keep recording the next line". It was off by default under `offbooked.keepRecording`, where
 * anyone who tried the switch (and turned it back off) left a "0"; the on-by-default setting starts
 * afresh under a new key so every device gets it.
 */
export const KEEP_RECORDING_KEY = "offbooked.recordNext";

/** The one line on the device's first take: what happens when the line is said. */
export function firstTakeHint(recordsNext: boolean): string {
  return `${recordsNext ? "Records the next line" : "Moves to the next line"} when you finish. Change this in mic settings.`;
}

/** A yes/no setting kept in localStorage ("1"/"0"), or `fallback` when this device never chose. */
export function storedFlag(key: string, fallback: boolean): boolean {
  const stored = readStorage(key);
  return stored === null ? fallback : stored === "1";
}

/** A yes/no setting kept in localStorage; only a choice is written, so a new default reaches everyone who never chose. Without storage it lasts the visit. */
export function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => storedFlag(key, fallback));
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writeStorage(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set] as const;
}

/** Stop and move on when the line is said, and record the next one straight away: both on by default, so recording is hands-free. */
export function useRecordOptions() {
  const [autoAdvance, setAutoAdvance] = useStoredFlag(AUTO_ADVANCE_KEY, true);
  const [keepRecording, setKeepRecording] = useStoredFlag(KEEP_RECORDING_KEY, true);
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
