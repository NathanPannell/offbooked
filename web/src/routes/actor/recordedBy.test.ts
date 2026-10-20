import { describe, expect, it } from "vitest";
import type { ActorLine, Take } from "../../api/types";
import { lineTake, nextToRecord, opensOnWrapped, ownTake, recordedByLabel, takeAuthor, type AuthorContext } from "./recordedBy";

const actorCtx: AuthorContext = { me: "actor", actorName: "Someone in the cast", directorName: "Jo" };
const directorCtx: AuthorContext = { me: "director", actorName: "the cast", directorName: "Jo" };

function take(id: string, extra: Partial<Take> = {}): Take {
  return { id, lineId: `l-${id}`, audioUrl: `https://audio/${id}`, durationMs: 1200, createdAt: "2026-10-20T00:00:00Z", stt: null, ...extra };
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

const robin = (id: string) => take(id, { recordedBy: { kind: "actor", name: "Robin" }, mine: false });
const mine = (id: string) => take(id, { recordedBy: { kind: "actor", name: "Riz" }, mine: true });

describe("who recorded a take", () => {
  it("reads the name and whether it's mine from the server", () => {
    expect(takeAuthor(robin("t1"), actorCtx)).toEqual({ kind: "actor", name: "Robin", mine: false });
    expect(takeAuthor(take("t2", { recordedBy: { kind: "director", name: "Jo" }, mine: true }), directorCtx)).toEqual({
      kind: "director",
      name: "Jo",
      mine: true,
    });
    expect(recordedByLabel(takeAuthor(robin("t1"), actorCtx))).toBe("Recorded by Robin");
    expect(recordedByLabel(takeAuthor(mine("t3"), actorCtx))).toBe("Recorded by you");
  });

  it("falls back on older servers", () => {
    // The actor's recorder only ever got their own takes.
    expect(takeAuthor(take("t1"), actorCtx).mine).toBe(true);
    expect(takeAuthor(take("t1", { recordedBy: "actor" }), actorCtx).mine).toBe(true);
    // In a studio, a stand-in was the director's own and anything else the cast's.
    expect(takeAuthor(take("t2", { recordedBy: "standin" }), directorCtx)).toEqual({ kind: "director", name: "Jo", mine: true });
    expect(takeAuthor(take("t3", { recordedBy: "actor" }), directorCtx)).toEqual({ kind: "actor", name: "the cast", mine: false });
  });

  it("uses what plays now when the line has no take of its own", () => {
    const l = line("a", { current: { source: "actor", by: "Robin", audioUrl: "https://audio/robin" } });
    expect(lineTake(l, actorCtx)).toEqual({ url: "https://audio/robin", durationMs: null, author: { kind: "actor", name: "Robin", mine: false } });
    const standin = line("b", { current: { source: "standin", by: null, audioUrl: "https://audio/jo" } });
    expect(lineTake(standin, actorCtx)?.author).toEqual({ kind: "director", name: "Jo", mine: false });
    expect(lineTake(line("c"), actorCtx)).toBeNull();
    expect(lineTake(line("d", { take: mine("t") }), actorCtx)?.author.mine).toBe(true);
  });

  it("only counts the person's own take as theirs", () => {
    expect(ownTake(line("a", { take: mine("t1") }), actorCtx)?.id).toBe("t1");
    expect(ownTake(line("b", { take: robin("t2") }), actorCtx)).toBeNull();
    expect(ownTake(line("c"), actorCtx)).toBeNull();
  });
});

describe("where the recorder opens", () => {
  it("lands someone who picked up a part others recorded on the lines, not on wrapped", () => {
    const pickedUp = [line("a", { take: robin("t1") }), line("b", { current: { source: "actor", by: "Robin", audioUrl: "u" } })];
    expect(opensOnWrapped(pickedUp, actorCtx)).toBe(false);
  });

  it("opens on wrapped once every line is in and some of it is theirs", () => {
    expect(opensOnWrapped([line("a", { take: mine("t1") }), line("b", { take: robin("t2") })], actorCtx)).toBe(true);
    expect(opensOnWrapped([line("a", { take: mine("t1") }), line("b")], actorCtx)).toBe(false);
    expect(opensOnWrapped([], actorCtx)).toBe(false);
  });

  it("still opens on wrapped for an older server's own takes", () => {
    expect(opensOnWrapped([line("a", { take: take("t1") })], actorCtx)).toBe(true);
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
