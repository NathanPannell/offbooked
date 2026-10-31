import { describe, expect, it } from "vitest";
import { cleanLink, directorMessage, directorUrl, greeting, readDirectorLink } from "./directorLink";

describe("the link a cast member sends their director", () => {
  it("reads who sent it and which show", () => {
    expect(readDirectorLink("?from=Maya&show=Macbeth")).toEqual({ from: "Maya", show: "Macbeth" });
    expect(readDirectorLink("?show=Into%20the%20Woods")).toEqual({ from: "", show: "Into the Woods" });
    expect(readDirectorLink("")).toEqual({ from: "", show: "" });
  });

  it("keeps names and titles as people write them", () => {
    expect(cleanLink("Zoë O’Brien-Nguyễn", "Who's Afraid of Virginia Woolf?")).toEqual({ from: "Zoë O’Brien-Nguyễn", show: "Who's Afraid of Virginia Woolf?" });
    expect(cleanLink("Sam", "Mr. Burns & Macbeth 2.2").show).toBe("Mr. Burns & Macbeth 2.2");
    expect(cleanLink("  Sam \n  Lee ", null).from).toBe("Sam Lee");
  });

  it("never shows markup or a web address", () => {
    expect(cleanLink("<script>alert(1)</script>", null).from).toBe("script alert 1 script");
    expect(cleanLink("evil.com", null).from).toBe("");
    expect(cleanLink("http://evil.example/login", null).from).toBe("");
    expect(cleanLink(null, "Visit www.evil.com now").show).toBe("");
    expect(cleanLink("!!!", null).from).toBe("!!!");
  });

  it("isn't fooled by invisible marks, numbers or our own name", () => {
    expect(cleanLink("evil.c\u034Fom", null).from).toBe("");
    expect(cleanLink("evil\uFE0F.com", null).from).toBe("");
    expect(cleanLink("evil . com", null).from).toBe("");
    expect(cleanLink("192.168.1.1", null).from).toBe("");
    expect(cleanLink(null, "your refund, call 250 555 0199").show).toBe("");
    expect(cleanLink("The Offbooked team", null).from).toBe("");
    expect(cleanLink(null, "Twelve Angry Men 1957").show).toBe("Twelve Angry Men 1957");
  });

  it("caps what the page will show", () => {
    expect(cleanLink("a".repeat(100), "b".repeat(100))).toEqual({ from: "a".repeat(40), show: "b".repeat(60) });
  });

  it("leaves empty fields out of the address, and survives the trip through it", () => {
    expect(directorUrl("https://offbooked.com", { from: "", show: "" })).toBe("https://offbooked.com/director");
    expect(directorUrl("https://offbooked.com", { from: "", show: "Hamlet" })).toBe("https://offbooked.com/director?show=Hamlet");
    const link = { from: "Zoë O’Brien", show: "Who's Afraid & Why?" };
    expect(readDirectorLink(new URL(directorUrl("https://offbooked.com", link)).search)).toEqual(link);
  });

  it("greets the director with what it knows", () => {
    expect(greeting({ from: "Maya", show: "Macbeth" })).toBe("Maya sent you this for Macbeth.");
    expect(greeting({ from: "Maya", show: "" })).toBe("Maya, from your cast, sent you this.");
    expect(greeting({ from: "", show: "Macbeth" })).toBe("Sent with Macbeth in mind.");
    expect(greeting({ from: "", show: "" })).toBeNull();
    expect(greeting({ from: "Maya", show: "Who's Afraid of Virginia Woolf?" })).toBe("Maya sent you this for Who's Afraid of Virginia Woolf?");
  });

  it("writes a message that carries the link and only what was given", () => {
    const named = directorMessage({ from: "Maya", show: "Macbeth" }, "https://offbooked.com/director?x");
    expect(named).toContain("off book for Macbeth.");
    expect(named).toContain("https://offbooked.com/director?x");
    expect(named.endsWith("Maya")).toBe(true);
    expect(directorMessage({ from: "", show: "" }, "u")).toContain("off book. We each");
    expect(directorMessage({ from: "", show: "Oklahoma!" }, "u")).toContain("for Oklahoma! We each");
  });
});
