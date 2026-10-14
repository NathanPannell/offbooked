import { describe, expect, it } from "vitest";
import { forgetJoin, joinTokenForInvite, recallJoin, rememberJoin, type StorageLike } from "./joinMemory";

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const thrower = () => {
  throw new Error("blocked");
};

describe("join memory", () => {
  it("remembers the invite per join link", () => {
    const s = memoryStorage();
    rememberJoin("joinA", { inviteToken: "inv1", firstName: "Sam", characterNames: ["HAMLET"], savedAt: 5 }, s);
    rememberJoin("joinB", { inviteToken: "inv2", firstName: "Ana", characterNames: [], savedAt: 6 }, s);
    expect(recallJoin("joinA", s)).toEqual({ inviteToken: "inv1", firstName: "Sam", characterNames: ["HAMLET"], savedAt: 5 });
    expect(recallJoin("joinB", s)?.inviteToken).toBe("inv2");
    expect(recallJoin("other", s)).toBeNull();
  });

  it("forgets one link without touching others", () => {
    const s = memoryStorage();
    rememberJoin("a", { inviteToken: "1", firstName: "", characterNames: [] }, s);
    rememberJoin("b", { inviteToken: "2", firstName: "", characterNames: [] }, s);
    forgetJoin("a", s);
    expect(recallJoin("a", s)).toBeNull();
    expect(recallJoin("b", s)?.inviteToken).toBe("2");
  });

  it("ignores corrupt values", () => {
    const s = memoryStorage({
      "offbooked.join.bad": "{not json",
      "offbooked.join.null": "null",
      "offbooked.join.empty": JSON.stringify({ inviteToken: "" }),
      "offbooked.join.partial": JSON.stringify({ inviteToken: "x", characterNames: ["A", 3] }),
    });
    expect(recallJoin("bad", s)).toBeNull();
    expect(recallJoin("null", s)).toBeNull();
    expect(recallJoin("empty", s)).toBeNull();
    expect(recallJoin("partial", s)).toEqual({ inviteToken: "x", firstName: "", characterNames: ["A"], savedAt: 0 });
  });

  it("finds the cast link behind an invite", () => {
    const s = memoryStorage({ "offbooked.session": "tok", other: "x" });
    rememberJoin("joinA", { inviteToken: "inv1", firstName: "", characterNames: [] }, s);
    expect(joinTokenForInvite("inv1", s)).toBe("joinA");
    expect(joinTokenForInvite("nope", s)).toBeNull();
  });

  it("survives storage that throws or is missing", () => {
    const broken: StorageLike = { getItem: thrower, setItem: thrower, removeItem: thrower, key: thrower, length: 1 };
    expect(() => rememberJoin("a", { inviteToken: "1", firstName: "", characterNames: [] }, broken)).not.toThrow();
    expect(() => forgetJoin("a", broken)).not.toThrow();
    expect(recallJoin("a", broken)).toBeNull();
    expect(joinTokenForInvite("1", broken)).toBeNull();
    expect(recallJoin("a", null)).toBeNull();
  });
});
