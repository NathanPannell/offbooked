import assert from "node:assert/strict";
import { test } from "node:test";
import { castFacingName, safeNext } from "./names.ts";

test("the cast sees the director's name, or the start of their email, never the address", () => {
  assert.equal(castFacingName("Sam", "sam@example.test"), "Sam");
  assert.equal(castFacingName("  Sam Ortiz ", "x@example.test"), "Sam Ortiz");
  assert.equal(castFacingName(null, "nathan@example.test"), "Nathan");
  assert.equal(castFacingName("", "nathan@example.test"), "Nathan");
  assert.equal(castFacingName("   ", "sam.ortiz+shows@example.test"), "Sam Ortiz");
  assert.equal(castFacingName(undefined, "jo_ann-lee@example.test"), "Jo Ann Lee");
  assert.equal(castFacingName("pat@example.test", "pat@example.test"), "Pat", "a name that is an email is treated as one");
  assert.equal(castFacingName("Sam @ Globe Rep", "sam@example.test"), "Sam @ Globe Rep", "only a whole email address is replaced");
  assert.equal(castFacingName(null, "+tag@example.test"), "Your director");
  assert.equal(castFacingName(null, "director.mvgc57xn@example.test"), "Director", "pieces with digits read as codes, not names");
  assert.equal(castFacingName(null, "jo2024@example.test"), "Your director");
  assert.equal(castFacingName(null, "mary-kate.o2@example.test"), "Mary Kate");
  for (const shown of [castFacingName(null, "nathan@example.test"), castFacingName("x@y.test", "x@y.test")]) assert.ok(!shown.includes("@"));
});

test("only paths inside the director app are accepted as where to go after signing in", () => {
  for (const ok of ["/app", "/app/new", "/app/p/123?tab=cast", "/app/account", "/app#top", "/app?x=1"]) assert.equal(safeNext(ok), ok);
  for (const bad of [
    undefined,
    null,
    42,
    "",
    "/",
    "/apple",
    "/application",
    "app/new",
    "/i/abc",
    "https://evil.test/app",
    "//evil.test/app",
    "/app//evil.test",
    "/app/\\evil.test",
    "/app/ new",
    "javascript:alert(1)",
    `/app/${"x".repeat(600)}`,
  ])
    assert.equal(safeNext(bad), null, String(bad));
});
