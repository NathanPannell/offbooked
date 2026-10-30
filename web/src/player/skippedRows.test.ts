import { describe, expect, it } from "vitest";
import { planCues } from "./cuePlan";
import type { QueueLine } from "./queue";
import { rowLabel, skippedRows } from "./skippedRows";

describe("the row that stands in for a stretch left out", () => {
  it("says how many lines and whose", () => {
    expect(rowLabel(14, ["Escalus", "Angelo"])).toBe("14 lines · Escalus, Angelo");
    expect(rowLabel(1, ["Escalus"])).toBe("1 line · Escalus");
    expect(rowLabel(5, [])).toBe("5 lines");
    expect(rowLabel(30, ["Escalus", "Angelo", "Isabella", "Claudio", "Lucio"])).toBe("30 lines · Escalus, Angelo, Isabella +2");
  });

  it("comes from the plan, one row a stretch, naming each speaker once and no stage direction", () => {
    const speakers = ["Mara", "Escalus", "Angelo", "Escalus", "", "Angelo", "Sam", "Mara"];
    const queue: QueueLine[] = speakers.map((_, i) => ({ lineId: `l${i}`, sectionId: "s", text: "Words." }));
    const plan = planCues(queue, new Set(["l0", "l7"]));
    const rows = skippedRows(queue, plan, (lineId) => speakers[Number(lineId.slice(1))]!);
    expect(rows).toEqual([{ lineId: "l1", from: 1, to: 6, label: "5 lines · Escalus, Angelo" }]);
  });

  it("is nothing with no part, or with everything playing", () => {
    expect(skippedRows([], null, () => "")).toEqual([]);
    const queue: QueueLine[] = Array.from({ length: 9 }, (_, i) => ({ lineId: `l${i}`, sectionId: "s", text: "Words." }));
    expect(skippedRows(queue, planCues(queue, new Set(["l0", "l8"]), false), () => "")).toEqual([]);
  });
});
