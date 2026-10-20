import { describe, expect, it } from "vitest";
import { recorderDescription, recorderLabel } from "./recorders";

describe("recorder label", () => {
  it("names whoever recorded most, plus a count of the others", () => {
    expect(recorderLabel(null)).toBeNull();
    expect(recorderLabel({ name: "Robin", others: 0 })).toBe("Robin");
    expect(recorderLabel({ name: "Nathan", others: 2 })).toBe("Nathan + 2");
  });

  it("reads out in full for screen readers", () => {
    expect(recorderDescription(null)).toBe("not recorded yet");
    expect(recorderDescription({ name: "Robin", others: 0 })).toBe("recorded by Robin");
    expect(recorderDescription({ name: "Robin", others: 1 })).toBe("recorded mostly by Robin and 1 other");
    expect(recorderDescription({ name: "Robin", others: 3 })).toBe("recorded mostly by Robin and 3 others");
  });
});
