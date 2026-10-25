import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { bearer, createTestApp, dbSkip, signIn, type TestApp } from "../test/helpers.ts";

const NEW_SHOW = { title: "Macbeth", performanceEndsOn: "2027-03-01" };

describe("beta access", { skip: dbSkip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ env: { BETA_ACCESS_CODE: "Break a leg" } });
  });
  after(() => t.close());

  const me = async (session: string) => (await t.app.inject({ method: "GET", url: "/api/me", headers: bearer(session) })).json().user;
  const create = (session: string) => t.app.inject({ method: "POST", url: "/api/productions", headers: bearer(session), payload: NEW_SHOW });
  const enter = (session: string, code: unknown) => t.app.inject({ method: "POST", url: "/api/me/beta-access", headers: bearer(session), payload: { code } });

  test("a new account can't set up a production until it enters the code, then can for good", async () => {
    const session = await signIn(t, "new@example.test", { beta: false });
    assert.equal((await me(session)).betaAccess, false);

    const denied = await create(session);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, "beta_access_required");
    assert.equal((await t.ctx.sql`select 1 from productions`).length, 0);

    const wrong = await enter(session, "break a log");
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.code, "wrong_code");
    assert.equal((await me(session)).betaAccess, false);
    assert.equal((await enter(session, "")).statusCode, 400);

    // Case, punctuation and spacing don't matter.
    const granted = await enter(session, "  BREAK, a leg! ");
    assert.equal(granted.statusCode, 200);
    assert.equal(granted.json().user.betaAccess, true);
    assert.equal((await me(session)).betaAccess, true);
    assert.equal((await create(session)).statusCode, 200);

    // It belongs to the account, not the session: signing in again keeps it, and so does a rename.
    const later = await signIn(t, "new@example.test", { beta: false });
    assert.equal((await me(later)).betaAccess, true);
    const renamed = await t.app.inject({ method: "PATCH", url: "/api/me", headers: bearer(later), payload: { name: "Robin" } });
    assert.equal(renamed.json().user.betaAccess, true);
    // Entering a code again once it has access is harmless, even a wrong one.
    assert.equal((await enter(later, "anything")).json().user.betaAccess, true);
  });

  test("tries are rate limited per account, right or wrong", async () => {
    const session = await signIn(t, "guesser@example.test", { beta: false });
    for (let i = 0; i < 10; i++) assert.equal((await enter(session, `guess ${i}`)).statusCode, 400);
    const limited = await enter(session, "break a leg");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal((await me(session)).betaAccess, false);
  });

  test("the migration grandfathers every account that existed before the gate, never a deleted one", async () => {
    await t.ctx.sql`insert into users (email) values ('before@example.test')`;
    await t.ctx.sql`insert into users (email, deleted_at) values ('gone@example.test', now())`;
    const [fresh] = await t.ctx.sql<{ betaAccessAt: Date | null }[]>`select beta_access_at from users where email = 'before@example.test'`;
    assert.equal(fresh!.betaAccessAt, null, "a new account starts without access");

    await t.ctx.sql.unsafe(await readFile(new URL("../../migrations/019_beta_access.sql", import.meta.url), "utf8"));
    const rows = await t.ctx.sql<{ email: string; betaAccessAt: Date | null }[]>`
      select email, beta_access_at from users where email in ('before@example.test', 'gone@example.test')`;
    assert.ok(rows.find((r) => r.email === "before@example.test")!.betaAccessAt);
    assert.equal(rows.find((r) => r.email === "gone@example.test")!.betaAccessAt, null);
  });

  test("the code comes from BETA_ACCESS_CODE, and defaults to “break a leg”", async () => {
    assert.equal(t.ctx.config.betaAccessCode, "Break a leg");
    const { loadConfig } = await import("../config.ts");
    const base = { DATABASE_URL: "postgres://x", SESSION_SECRET: "s", INVITE_TOKEN_SECRET: "i" };
    assert.equal(loadConfig(base).betaAccessCode, "break a leg");
    assert.equal(loadConfig({ ...base, BETA_ACCESS_CODE: "  " }).betaAccessCode, "break a leg");
    assert.equal(loadConfig({ ...base, BETA_ACCESS_CODE: " merde " }).betaAccessCode, "merde");
  });
});
