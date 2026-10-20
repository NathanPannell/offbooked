import { describe, expect, it } from "vitest";
import type { ActorLine, Take } from "../../api/types";
import { lineTake, nextToRecord, opensOnWrapped, ownTake, recordedByLabel, takeAuthor } from "./recordedBy";

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

  it("then to lines someone else recorded, going round", () => {
    const done = lines.map((l) => (l.id === "c" ? { ...l, recorded: true, mine: true } : l));
    expect(nextToRecord(done, "c")).toBe("d");
    expect(nextToRecord(done, "d")).toBe("b");
  });

  it("skips the line just recorded, and stops when every line is theirs", () => {
    expect(nextToRecord([{ id: "a", recorded: false, mine: false }], "a", new Set(["a"]))).toBeNull();
    expect(nextToRecord([{ id: "a", recorded: true, mine: true }], "a")).toBeNull();
  });
});
