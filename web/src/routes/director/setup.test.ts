import { describe, expect, it, vi } from "vitest";
import type { Character, Line } from "../../api/types";
import { longDate } from "../../lib/format";
import { localToday, performanceDatesProblem, readingLine, readingLines, readSummary, scriptFileProblem, sendSetup, type SetupApi } from "./setup";

const file = (name: string, type = "", size = 1000) => ({ name, type, size });

describe("scriptFileProblem", () => {
  it("takes PDF and Word files only", () => {
    expect(scriptFileProblem(file("hamlet.pdf"))).toBeNull();
    expect(scriptFileProblem(file("HAMLET.DOCX"))).toBeNull();
    expect(scriptFileProblem(file("script", "application/pdf"))).toBeNull();
    expect(scriptFileProblem(file("hamlet.txt", "text/plain"))).toMatch(/PDF or a Word/);
    expect(scriptFileProblem(file("hamlet.doc", "application/msword"))).toMatch(/PDF or a Word/);
    expect(scriptFileProblem(file("hamlet.fountain"))).toMatch(/PDF or a Word/);
  });

  it("turns away empty files and anything over 20 MB", () => {
    expect(scriptFileProblem(file("hamlet.pdf", "", 21 * 1024 * 1024))).toMatch(/over 20 MB/);
    expect(scriptFileProblem(file("hamlet.pdf", "", 0))).toMatch(/empty/);
  });
});

describe("performanceDatesProblem", () => {
  const today = "2026-10-20";
  it("needs both dates, in order, with the final one still to come", () => {
    expect(performanceDatesProblem("", "", today)).toMatch(/first and final/);
    expect(performanceDatesProblem("2026-11-01", "", today)).toMatch(/first and final/);
    expect(performanceDatesProblem("2026-11-08", "2026-11-01", today)).toMatch(/before the first/);
    expect(performanceDatesProblem("2026-09-01", "2026-10-01", today)).toMatch(/already passed/);
    expect(performanceDatesProblem("2026-11-01", "2026-11-01", today)).toBeNull();
    // A run that has already opened can still be set up.
    expect(performanceDatesProblem("2026-10-01", "2026-10-20", today)).toBeNull();
  });

  it("reads today in the browser's own time zone", () => {
    expect(localToday(new Date(2027, 0, 5, 23, 30))).toBe("2027-01-05");
  });
});

describe("reading lines", () => {
  it("follow the real stage, starting with the file name", () => {
    expect(readingLine(0, "hamlet.pdf", 0)).toBe("Reading through hamlet.pdf…");
    expect(readingLine(0, null, 0)).toBe("Reading through your script…");
    expect(readingLine(1, "hamlet.pdf", 0)).toBe("Separating characters…");
    expect(readingLines(1, null)).toContain("Double-checking stage directions…");
    expect(readingLine(2, null, 0)).toBe("Setting out the parts…");
  });

  it("move on every few seconds and stay on the last line", () => {
    expect(readingLine(1, null, 3499)).toBe("Separating characters…");
    expect(readingLine(1, null, 3500)).toBe("Finding the scenes…");
    expect(readingLine(1, null, 999_999)).toBe(readingLines(1, null).at(-1));
    expect(readingLine(1, null, -50)).toBe("Separating characters…");
  });
});

describe("readSummary", () => {
  const line = (kind: Line["kind"]) => ({ kind }) as Line;
  const character = (group = false) => ({ group }) as Character;

  it("counts dialogue lines and the parts the cast can take", () => {
    const lines = [...Array.from({ length: 1223 }, () => line("dialogue")), line("stage_direction"), line("heading")];
    const characters = [...Array.from({ length: 34 }, () => character()), character(true)];
    expect(readSummary({ lines, characters }, "en-US")).toBe("Read 1,223 lines across 34 parts");
    expect(readSummary({ lines: [line("dialogue")], characters: [character()] }, "en-US")).toBe("Read 1 line across 1 part");
  });
});

describe("longDate", () => {
  it("reads a calendar date without shifting the day", () => {
    expect(longDate("2027-06-12", "en-GB")).toBe("12 June 2027");
  });
});

describe("sendSetup", () => {
  const draft = { title: "  Hamlet ", performanceStartsOn: "2027-06-01", performanceEndsOn: "2027-06-05", file: new File(["%PDF"], "hamlet.pdf") };
  const api = (): SetupApi & { [K in keyof SetupApi]: ReturnType<typeof vi.fn> } => ({
    create: vi.fn(async () => ({ production: { id: "p1" } })),
    update: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({ scriptStatus: "parsing" })),
  });
  const details = { title: "Hamlet", performanceStartsOn: "2027-06-01", performanceEndsOn: "2027-06-05" };

  it("creates the production with its dates, then uploads the script", async () => {
    const a = api();
    const created = vi.fn();
    await expect(sendSetup(a, draft, null, created)).resolves.toBe("p1");
    expect(a.create).toHaveBeenCalledWith(details);
    expect(created).toHaveBeenCalledWith("p1");
    expect(a.upload).toHaveBeenCalledWith("p1", draft.file);
    expect(a.update).not.toHaveBeenCalled();
  });

  it("keeps the new id when the upload fails, and a retry updates that production instead of making another", async () => {
    const a = api();
    a.upload.mockRejectedValueOnce(new Error("offline"));
    let id: string | null = null;
    await expect(sendSetup(a, draft, id, (v) => (id = v))).rejects.toThrow("offline");
    expect(id).toBe("p1");

    await expect(sendSetup(a, draft, id, () => {})).resolves.toBe("p1");
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(a.update).toHaveBeenCalledWith("p1", details);
    expect(a.upload).toHaveBeenCalledTimes(2);
  });

  it("uploads nothing when the production can't be made", async () => {
    const a = api();
    a.create.mockRejectedValueOnce(new Error("signed out"));
    await expect(sendSetup(a, draft, null, () => {})).rejects.toThrow("signed out");
    expect(a.upload).not.toHaveBeenCalled();
  });
});
