import { describe, expect, it } from "vitest";
import type { ActorLine, Take } from "../../api/types";
import { lineTake, nextToRecord, opensOnWrapped, ownTake, partInView, recordedByLabel, takeAuthor } from "./recordedBy";

function take(id: string, by: { kind: "actor" | "director"; name: string }, mine: boolean): Take {
  return { id, lineId: `l-${id}`, audioUrl: `https://audio/${id}`, durationMs: 1200, createdAt: "2026-10-20T00:00:00Z", stt: null, recordedBy: by, mine };
}

function line(id: string, extra: Partial<ActorLine> = {}): ActorLine {
  return {
    line: { id, sectionId: "s1", seq: 1, kind: "dialogue", characterId: "c1", text: "A line." } as ActorLine["line"],
    sectionTitle: "Act 1",
    cue: null,
    directions: [],
    take: null,
    ...extra,
  };
}

const mine = (id: string) => take(id, { kind: "actor", name: "Riz" }, true);
const robinNow = {
  source: "actor" as const,
  by: "Robin",
  recordedBy: { kind: "actor" as const, name: "Robin" },
  mine: false as const,
  audioUrl: "https://audio/robin",
};
const directorNow = {
  source: "director" as const,
  by: "Jo",
  recordedBy: { kind: "director" as const, name: "Jo" },
  mine: false as const,
  audioUrl: "https://audio/jo",
};

describe("who recorded a take", () => {
  it("reads the name and whether it's mine", () => {
    expect(takeAuthor(take("t1", { kind: "actor", name: "Robin" }, false))).toEqual({ kind: "actor", name: "Robin", mine: false });
    expect(takeAuthor(take("t2", { kind: "director", name: "Jo" }, true))).toEqual({ kind: "director", name: "Jo", mine: true });
    expect(recordedByLabel(takeAuthor(take("t1", { kind: "actor", name: "Robin" }, false)))).toBe("Recorded by Robin");
    expect(recordedByLabel(takeAuthor(mine("t3")))).toBe("Recorded by you");
  });

  it("uses what plays now when the line has no take of the actor's own", () => {
    expect(lineTake(line("a", { current: robinNow }))).toEqual({
      url: "https://audio/robin",
      durationMs: null,
      author: { kind: "actor", name: "Robin", mine: false },
    });
    expect(lineTake(line("b", { current: directorNow }))?.author).toEqual({ kind: "director", name: "Jo", mine: false });
    expect(lineTake(line("c"))).toBeNull();
    expect(lineTake(line("d", { take: mine("t") }))?.author.mine).toBe(true);
  });

  it("only counts the person's own take as theirs", () => {
    expect(ownTake(line("a", { take: mine("t1") }))?.id).toBe("t1");
    expect(ownTake(line("b", { take: take("t2", { kind: "director", name: "Jo" }, false) }))).toBeNull();
    expect(ownTake(line("c", { current: robinNow }))).toBeNull();
    expect(ownTake(line("d"))).toBeNull();
  });
});

describe("where the recorder opens", () => {
  it("lands someone who picked up a part others recorded on the lines, not on wrapped", () => {
    expect(opensOnWrapped([line("a", { current: robinNow }), line("b", { current: directorNow })])).toBe(false);
  });

  it("opens on wrapped once every line is in and some of it is theirs", () => {
    expect(opensOnWrapped([line("a", { take: mine("t1") }), line("b", { current: robinNow })])).toBe(true);
    expect(opensOnWrapped([line("a", { take: mine("t1") }), line("b")])).toBe(false);
    expect(opensOnWrapped([])).toBe(false);
  });
});

describe("the next line to record", () => {
  const lines = [
    { id: "a", recorded: true, mine: true },
    { id: "b", recorded: true, mine: false },
    { id: "c", recorded: false, mine: false },
    { id: "d", recorded: true, mine: false },
  ];

  it("goes to a line nobody has recorded first", () => {
    expect(nextToRecord(lines, "a")).toBe("c");
    expect(nextToRecord(lines, "d")).toBe("c");
  });

  it("is wrapped once every line is recorded, whoever recorded the others", () => {
    // The bug: finishing the last line nobody had recorded moved on to (and, hands-free, recorded
    // over) a line the director or another cast member had recorded, instead of "You're wrapped".
    const done = lines.map((l) => (l.id === "c" ? { ...l, recorded: true, mine: true } : l));
    expect(nextToRecord(done, "c", new Set(["c"]))).toBeNull();
  });

  it("walks through others' takes only when recording over them", () => {
    const done = lines.map((l) => (l.id === "c" ? { ...l, recorded: true, mine: true } : l));
    expect(nextToRecord(done, "b", new Set(["b"]), true)).toBe("d");
    expect(nextToRecord(done, "d", new Set(["d"]), true)).toBe("b");
    expect(nextToRecord(done, "d", new Set(["d"]))).toBeNull();
  });

  it("skips the line just recorded, and stops when every line is theirs", () => {
    expect(nextToRecord([{ id: "a", recorded: false, mine: false }], "a", new Set(["a"]))).toBeNull();
    expect(nextToRecord([{ id: "a", recorded: true, mine: true }], "a")).toBeNull();
  });
});

describe("the part in view", () => {
  const parts = [{ id: "anna" }, { id: "ben" }];
  const said = (id: string, by: string, recorded: boolean) =>
    line(id, { line: { ...line(id).line, characterId: by }, take: recorded ? take(`t-${id}`, { kind: "actor", name: "Sam" }, true) : null });

  it("opens on the first part with lines needing a voice", () => {
    expect(partInView(parts, null, [said("a1", "anna", true), said("b1", "ben", false)])).toBe("ben");
    expect(partInView(parts, null, [said("a1", "anna", false), said("b1", "ben", false)])).toBe("anna");
    expect(partInView([{ id: "anna" }], null, [said("a1", "anna", false)])).toBeNull();
  });

  it("stays on the part the recorder kept once its last line is recorded", () => {
    // The bug: once ANNA's last take landed the part in view became BEN, and the wrapped screen
    // read "Ben's wrapped" over BEN's unrecorded lines. The recorder now keeps ANNA (chosen).
    const finished = [said("a1", "anna", true), said("a2", "anna", true), said("b1", "ben", false)];
    expect(partInView(parts, null, finished)).toBe("ben");
    expect(partInView(parts, "anna", finished)).toBe("anna");
    expect(partInView(parts, "gone", finished)).toBe("ben");
  });
});
