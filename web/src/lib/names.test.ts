import { describe, expect, it } from "vitest";
import { castFacingName, safeNext } from "./names";

describe("castFacingName", () => {
  it("uses the name once it is set", () => {
    expect(castFacingName("Sam", "sam@example.test")).toBe("Sam");
    expect(castFacingName("  Sam Ortiz ", "x@example.test")).toBe("Sam Ortiz");
  });

  it("falls back to the start of the email, capitalised, never the address", () => {
    expect(castFacingName(null, "nathan@example.test")).toBe("Nathan");
    expect(castFacingName("", "sam.ortiz+shows@example.test")).toBe("Sam Ortiz");
    expect(castFacingName("pat@example.test", "pat@example.test")).toBe("Pat");
    expect(castFacingName(null, "+x@example.test")).toBe("Your director");
  });
});

describe("safeNext", () => {
  it("keeps paths inside the director app", () => {
    for (const ok of ["/app", "/app/new", "/app/p/1?tab=cast", "/app/account", "/app#x"]) expect(safeNext(ok)).toBe(ok);
  });

  it("drops everything else", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "/",
      "/apple",
      "app",
      "/i/abc",
      "https://evil.test/app",
      "//evil.test",
      "/app//evil.test",
      "/app/\\evil",
      "/app/ x",
      `/app/${"x".repeat(600)}`,
    ])
      expect(safeNext(bad)).toBeNull();
  });
});
