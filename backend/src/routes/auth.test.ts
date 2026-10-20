import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { consume } from "../ratelimit.ts";
import { bearer, createTestApp, dbSkip, signIn, type TestApp } from "../test/helpers.ts";

describe("director auth", { skip: dbSkip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(() => t.close());

  test("magic link sign-in, profile, single use and logout", async () => {
    const req = await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email: "Sam@Example.test" } });
    assert.equal(req.statusCode, 200);
    const link = new URL(req.json().devLink);
    assert.equal(link.origin + link.pathname, "https://app.test/auth/verify");
    const token = link.searchParams.get("token");

    const verify = await t.app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
    assert.equal(verify.statusCode, 200);
    const { sessionToken, user } = verify.json();
    assert.equal(user.email, "sam@example.test");
    assert.equal(user.name, null);

    const again = await t.app.inject({ method: "POST", url: "/api/auth/verify", payload: { token } });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().error.code, "unauthorized");

    const patched = await t.app.inject({ method: "PATCH", url: "/api/me", headers: bearer(sessionToken), payload: { name: "Sam" } });
    assert.equal(patched.json().user.name, "Sam");
    const me = await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(sessionToken) });
    assert.deepEqual(me.json().user, { id: user.id, email: "sam@example.test", name: "Sam" });

    const [stored] = await t.ctx.sql`select token_hash from sessions where user_id = ${user.id}`;
    assert.notEqual(stored!.tokenHash, sessionToken, "sessions are stored hashed");

    const logout = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...bearer(sessionToken), "content-type": "application/json" } });
    assert.equal(logout.statusCode, 204);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(sessionToken) })).statusCode, 401);
  });

  test("the sign-in link carries where to go next, only inside the director app", async () => {
    const linkFor = async (next: unknown) => {
      const res = await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email: "next@example.test", next } });
      assert.equal(res.statusCode, 200);
      return new URL(res.json().devLink);
    };
    const kept = await linkFor("/app/p/abc?tab=cast");
    assert.equal(kept.searchParams.get("next"), "/app/p/abc?tab=cast");
    assert.ok(kept.searchParams.get("token"));
    for (const bad of ["https://evil.test/app", "//evil.test", "/i/abc", 7]) assert.equal((await linkFor(bad)).searchParams.has("next"), false);
  });

  test("missing or bad credentials get the error shape", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/productions" });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(Object.keys(res.json().error).sort(), ["code", "message"]);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/productions", headers: bearer("nope") })).statusCode, 401);
    const bad = await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email: "not-an-email" } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "bad_request");
    assert.equal((await t.app.inject({ method: "GET", url: "/api/nowhere" })).json().error.code, "not_found");
  });

  test("sign-in requests are rate limited per email", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email: "flood@example.test" } })).statusCode);
    }
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    const res = await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email: "flood@example.test" } });
    assert.equal(res.json().error.code, "rate_limited");
    assert.equal((await t.app.inject({ method: "POST", url: "/api/auth/request", payload: { email: "other@example.test" } })).statusCode, 200);
  });

  test("fixed-window limiter counts per key", async () => {
    const limit = { limit: 2, windowSeconds: 3600 };
    assert.equal(await consume(t.ctx.sql, "k:a", limit), true);
    assert.equal(await consume(t.ctx.sql, "k:a", limit), true);
    assert.equal(await consume(t.ctx.sql, "k:a", limit), false);
    assert.equal(await consume(t.ctx.sql, "k:b", limit), true);
  });

  test("CORS allows configured origins including wildcard hosts", async () => {
    const preflight = (origin: string) =>
      t.app.inject({
        method: "OPTIONS",
        url: "/api/productions",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,x-take-id" },
      });
    const ok = await preflight("https://offbooked-git-mvp-team.vercel.app");
    assert.equal(ok.headers["access-control-allow-origin"], "https://offbooked-git-mvp-team.vercel.app");
    assert.match(String(ok.headers["access-control-allow-headers"]), /X-Take-Id/i);
    assert.equal((await preflight("https://app.test")).headers["access-control-allow-origin"], "https://app.test");
    assert.equal((await preflight("https://evil.example")).headers["access-control-allow-origin"], undefined);
    assert.equal((await preflight("https://a.b.vercel.app")).headers["access-control-allow-origin"], undefined);
  });

  test("health still reports ffmpeg", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ffmpeg, "ffmpeg test");
    assert.ok(await signIn(t, "health@example.test"));
  });
});
