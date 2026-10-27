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
    const [user] = await t.ctx.sql<{ betaAccessAt: Date | null }[]>`select beta_access_at from users where email = 'new@example.test'`;
    assert.equal(user!.betaAccessAt, null);
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

  test("there is no access code to enter", async () => {
    const session = await signIn(t, "coder@example.test");
    const res = await t.app.inject({ method: "POST", url: "/api/me/beta-access", headers: bearer(session), payload: { code: "break a leg" } });
    assert.equal(res.statusCode, 404);
  });
});
