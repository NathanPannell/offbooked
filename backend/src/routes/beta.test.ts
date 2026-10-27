import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bearer, createTestApp, dbSkip, signIn, type TestApp } from "../test/helpers.ts";

// Offbooked is in public beta: any director who signs in can set up a production. The access-code
// gate (migration 019) is gone; its users.beta_access_at column is left in place, unused.
describe("public beta", { skip: dbSkip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp();
  });
  after(() => t.close());

  test("a brand-new account sets up a production with no access code", async () => {
    const session = await signIn(t, "new@example.test");
    const me = (await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(session) })).json().user;
    assert.equal(me.betaAccess, undefined);

    const created = await t.app.inject({
      method: "POST",
      url: "/api/productions",
      headers: bearer(session),
      payload: { title: "Macbeth", performanceEndsOn: "2027-03-01" },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().production.title, "Macbeth");
  });

  test("script reads are limited per IP across accounts, so new accounts can't spend without end", async () => {
    const upload = async (session: string) => {
      const created = await t.app.inject({
        method: "POST",
        url: "/api/productions",
        headers: bearer(session),
        payload: { title: "Show", performanceEndsOn: "2027-03-01" },
      });
      const id = created.json().production.id;
      return t.app.inject({
        method: "POST",
        url: `/api/productions/${id}/script`,
        headers: bearer(session),
        remoteAddress: "203.0.113.9",
        payload: { text: "A: Hello." },
      });
    };
    // Three accounts' worth from one address: each stays under its own 10 an hour, the address doesn't.
    const sessions = [await signIn(t, "many-0@example.test"), await signIn(t, "many-1@example.test"), await signIn(t, "many-2@example.test")];
    for (let i = 0; i < 30; i++) assert.equal((await upload(sessions[Math.floor(i / 10)]!)).statusCode, 202, `upload ${i + 1}`);
    const limited = await upload(await signIn(t, "many-3@example.test"));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "rate_limited");
  });

  test("there is no access code to enter", async () => {
    const session = await signIn(t, "coder@example.test");
    const res = await t.app.inject({ method: "POST", url: "/api/me/beta-access", headers: bearer(session), payload: { code: "break a leg" } });
    assert.equal(res.statusCode, 404);
  });
});
