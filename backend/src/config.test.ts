import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, signInAppUrl } from "./config.ts";

const base = { DATABASE_URL: "postgres://x", SESSION_SECRET: "s", INVITE_TOKEN_SECRET: "i", APP_URL: "https://offbooked.test/" };

test("EXTRA_APP_URLS takes exact origins only", () => {
  assert.deepEqual(loadConfig(base).extraAppUrls, []);
  assert.deepEqual(loadConfig({ ...base, EXTRA_APP_URLS: " https://staging.offbooked.test/ , http://localhost:4173" }).extraAppUrls, [
    "https://staging.offbooked.test",
    "http://localhost:4173",
  ]);
  for (const bad of ["https://*.vercel.app", "staging.offbooked.test", "https://staging.offbooked.test/app", "https://Staging.offbooked.test"]) {
    assert.throws(() => loadConfig({ ...base, EXTRA_APP_URLS: bad }), /exact origins/, bad);
  }
});

test("a sign-in link lands on the frontend that asked only when it is listed", () => {
  const config = loadConfig({ ...base, EXTRA_APP_URLS: "https://staging.offbooked.test" });
  assert.equal(signInAppUrl(config, "https://staging.offbooked.test"), "https://staging.offbooked.test");
  assert.equal(signInAppUrl(config, "https://offbooked.test"), "https://offbooked.test");
  assert.equal(signInAppUrl(config, "https://evil.vercel.app"), "https://offbooked.test");
  assert.equal(signInAppUrl(config, undefined), "https://offbooked.test");
});
