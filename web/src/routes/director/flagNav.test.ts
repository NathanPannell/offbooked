import { describe, expect, it } from "vitest";
import type { Line } from "../../api/types";
import { flagPosition, nextFlagged } from "./flagNav";

const line = (seq: number, flagged = false): Line => ({
  id: `l${seq}`,
  seq,
  sectionId: "s",
  kind: "dialogue",
  characterId: null,
  text: "",
  flagged,
  flagReason: null,
});

// Flagged at seq 2, 5 and 9, given out of order.
const lines = [line(5, true), line(1), line(2, true), line(3), line(9, true), line(7)];

describe("flagged line navigation", () => {
  it("reports where you are among flagged lines", () => {
    expect(flagPosition(lines, "l5")).toEqual({ index: 2, total: 3 });
    expect(flagPosition(lines, "l3")).toEqual({ index: null, total: 3 });
    expect(flagPosition(lines, null)).toEqual({ index: null, total: 3 });
  });

  it("goes forward and back in script order, wrapping", () => {
    expect(nextFlagged(lines, null)?.id).toBe("l2");
    expect(nextFlagged(lines, null, -1)?.id).toBe("l9");
    expect(nextFlagged(lines, 2)?.id).toBe("l5");
    expect(nextFlagged(lines, 9)?.id).toBe("l2");
    expect(nextFlagged(lines, 5, -1)?.id).toBe("l2");
    expect(nextFlagged(lines, 2, -1)?.id).toBe("l9");
  });

  it("continues from a line that is no longer flagged or no longer exists", () => {
    // l5 was resolved: carry on to the next one after it.
    const resolved = lines.map((l) => (l.id === "l5" ? { ...l, flagged: false } : l));
    expect(nextFlagged(resolved, 5)?.id).toBe("l9");
    // From an unflagged line between flags.
    expect(nextFlagged(lines, 3)?.id).toBe("l5");
    expect(nextFlagged(lines, 6, -1)?.id).toBe("l5");
  });

  it("returns null when everything is checked", () => {
    expect(nextFlagged([line(1), line(2)], 1)).toBeNull();
    expect(flagPosition([line(1)], "l1")).toEqual({ index: null, total: 0 });
  });
});
