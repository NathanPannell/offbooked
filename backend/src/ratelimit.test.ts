import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { secondsLeft } from "./ratelimit.ts";

describe("rate limit windows", () => {
  test("Retry-After counts down to the end of the fixed window, never below a second", () => {
    assert.equal(secondsLeft(600, 0), 600);
    assert.equal(secondsLeft(600, 599_500), 1);
    assert.equal(secondsLeft(600, 600_000), 600);
    assert.equal(secondsLeft(600, 1_000_000), 200);
  });
});
