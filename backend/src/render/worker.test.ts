import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { Ctx } from "../context.ts";
import { createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { scheduleRender, startRenderWorker } from "./queue.ts";

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(25);
  }
}

describe("render worker", { skip: dbSkip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ env: { RENDER_DEBOUNCE_MS: "400" } });
  });
  after(() => t.close());

  test("sleeps until a queued render is due, then sends no queries while idle", { timeout: 60_000 }, async () => {
    // Counts every query the worker sends, so an idle worker can be shown to send none.
    let queries = 0;
    const sql = new Proxy(t.ctx.sql, {
      apply(target, self, args) {
        queries++;
        return Reflect.apply(target, self, args);
      },
    });
    const ctx: Ctx = { ...t.ctx, sql };
    const worker = startRenderWorker(ctx);
    ctx.renderWorker = worker;
    try {
      // Startup pass: one claim attempt and one look for the next due job, then nothing.
      await waitFor(() => queries === 2);
      await delay(2500);
      assert.equal(queries, 2, "idle worker sent queries");

      const director = await signIn(t, "director@example.test");
      const { id } = await productionWithScript(t, director, "ANNA: Hello there.\nBEN: Hi.");
      const queuedAt = Date.now();
      await scheduleRender(ctx, id);
      const status = async () => (await t.ctx.sql<{ status: string }[]>`select status from renders where production_id = ${id}`)[0]?.status;
      assert.equal(await status(), "queued");
      await waitFor(async () => (await status()) === "ready");
      assert.ok(Date.now() - queuedAt >= 350, "render ran before its debounce");

      await delay(100);
      const settled = queries;
      await delay(2500);
      assert.equal(queries, settled, "worker kept querying after the render");
    } finally {
      await worker.stop();
    }
  });
});
