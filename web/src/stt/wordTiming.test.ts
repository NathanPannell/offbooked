import { describe, expect, it } from "vitest";
import { addVoiced, LISTEN_TAIL_MS, listenEndMs, type Stretch, type TakeTiming } from "./wordTiming";

/** Stretches from a list of [start, end] pairs. */
const voiced = (...pairs: [number, number][]): Stretch[] => pairs.map(([startMs, endMs]) => ({ startMs, endMs }));

describe("addVoiced", () => {
  it("joins voiced time across the gaps between words, and starts a new stretch after a pause", () => {
    const s: Stretch[] = [];
    addVoiced(s, 300, 500);
    addVoiced(s, 340, 560); // the same run, growing
    addVoiced(s, 650, 800); // a 90 ms gap between words
    addVoiced(s, 1000, 1200); // a 200 ms pause
    expect(s).toEqual(voiced([300, 800], [1000, 1200]));
    expect(addVoiced(s, 900, 900)).toHaveLength(2);
  });
});

describe("listenEndMs", () => {
  // The line at 0.3–0.8 s and 1.0–1.8 s, its end heard by a pass over the audio to 2.0 s, then a
  // breath for the next line at 2.6–3.0 s.
  const timing = (): TakeTiming => ({ lineId: "l1", offsetMs: 40, stretches: voiced([300, 800], [1000, 1800], [2600, 3000]), lineEndMs: 2000 });

  it("stops Listen back after the line's last voice, before the pause that ended the take", () => {
    expect(listenEndMs(timing(), "l1", 4000)).toBe(1800 + 40 + LISTEN_TAIL_MS);
  });

  it("keeps the whole stretch the end was heard in, when the pass came while it was still being said", () => {
    expect(listenEndMs({ ...timing(), lineEndMs: 1500 }, "l1", 4000)).toBe(1800 + 40 + LISTEN_TAIL_MS);
  });

  it("plays it all when the end wasn't heard, it's another line, or there's nothing to leave out", () => {
    expect(listenEndMs({ ...timing(), lineEndMs: null }, "l1", 4000)).toBeNull();
    expect(listenEndMs(timing(), "l2", 4000)).toBeNull();
    expect(listenEndMs(null, "l1", 4000)).toBeNull();
    expect(listenEndMs(timing(), "l1", 2200)).toBeNull();
  });
});
