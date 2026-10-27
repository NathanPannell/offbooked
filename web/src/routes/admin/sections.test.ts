import { describe, expect, test } from "vitest";
import { personPath } from "../../api/admin";
import { ADMIN_SECTIONS, sectionById } from "./sections";
import { sum } from "./totals";

describe("the admin section registry", () => {
  test("each section has its own URL segment, a label and a summary", () => {
    const ids = ADMIN_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ADMIN_SECTIONS) {
      expect(s.id).toMatch(/^[a-z][a-z-]*$/);
      expect(s.label.trim()).not.toBe("");
      expect(s.summary.trim()).not.toBe("");
    }
    // "people" is the trace page's segment, not a panel.
    expect(ids).not.toContain("people");
  });

  test("looks a section up by its segment", () => {
    expect(sectionById("creators")?.label).toBe("Creators");
    expect(sectionById("nope")).toBeUndefined();
    expect(sectionById(undefined)).toBeUndefined();
  });
});

test("person paths keep the key in one segment, and totals add up", () => {
  expect(personPath("e:riz+cast@example.test")).toBe("/app/admin/people/e%3Ariz%2Bcast%40example.test");
  expect(sum([{ n: 2 }, { n: 3 }], (r) => r.n)).toBe(5);
  expect(sum([], () => 1)).toBe(0);
});
