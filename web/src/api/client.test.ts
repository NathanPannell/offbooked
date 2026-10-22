import { describe, expect, it } from "vitest";
import { ApiError, retryAfterMs } from "./client";

describe("retryAfterMs", () => {
  it("reads seconds or an HTTP date", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs("Thu, 22 Oct 2026 04:00:10 GMT", Date.parse("Thu, 22 Oct 2026 04:00:00 GMT"))).toBe(10_000);
    expect(retryAfterMs("Thu, 22 Oct 2026 03:00:00 GMT", Date.parse("Thu, 22 Oct 2026 04:00:00 GMT"))).toBe(0);
  });

  it("ignores a missing or unreadable header", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs(" ")).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs("-5")).toBeNull();
  });

  it("travels with the error", () => {
    expect(new ApiError(429, "rate_limited", "Slow down.", null, 5000).retryAfterMs).toBe(5000);
    expect(new ApiError(0, "network", "Offline.", null).retryAfterMs).toBeNull();
  });
});
