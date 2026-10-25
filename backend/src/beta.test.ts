import assert from "node:assert/strict";
import { test } from "node:test";
import { codeMatches, DEFAULT_BETA_ACCESS_CODE, normalizeCode } from "./beta.ts";

test("access codes ignore case, punctuation, accents and spacing", () => {
  assert.equal(normalizeCode("  Break, a LEG!  "), "breakaleg");
  for (const typed of ["break a leg", "Break a leg!", "BREAK  A  LEG", "break-a-leg", " breakaleg ", "Bréak a lég."]) {
    assert.ok(codeMatches(typed, DEFAULT_BETA_ACCESS_CODE), typed);
  }
});

test("a different or empty code never matches", () => {
  for (const typed of ["break a let", "break a leg please", "", "   ", "!!!"]) assert.equal(codeMatches(typed, DEFAULT_BETA_ACCESS_CODE), false, typed);
  assert.equal(codeMatches("anything", "!!"), false);
  assert.ok(codeMatches("Merde!", "merde"));
});
