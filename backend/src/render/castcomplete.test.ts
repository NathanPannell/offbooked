import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { makeTone } from "./ffmpeg.ts";

// The completion emails no longer wait for a stitched render: they go out when the cast is
// complete, however it got there.
describe("cast completion emails", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let wav: Buffer;
  before(async () => {
    t = await createTestApp();
    director = await signIn(t, "dir@example.test");
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-cast-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
  });
  after(() => t.close());

  const complete = () => t.mailer.sent.filter((m) => m.subject === "Cast complete — ready to listen through").length;
  const upload = (who: { inviteUrl: string }, lineId: string) =>
    t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: { ...invite(who.inviteUrl), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });
  const resend = async (pid: string) => {
    await t.ctx.sql`delete from notifications where production_id = ${pid}`;
    t.mailer.sent.length = 0;
  };

  test("after the take that completes it, after a take put back, and after a script edit", async () => {
    const made = await productionWithScript(t, director, "ANNA: Hello there.\nBEN: Hi.\nANNA: Bye now.", "Done");
    const pid = made.id as string;
    const chars = new Map<string, string>(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
    const [first, , last] = made.script.lines.filter((l: { kind: string }) => l.kind === "dialogue") as { id: string }[];
    const riz = (
      await t.app.inject({
        method: "POST",
        url: `/api/productions/${pid}/cast`,
        headers: bearer(director),
        payload: { name: "Riz", characterIds: [chars.get("ANNA")] },
      })
    ).json().member as { inviteUrl: string };

    assert.equal((await upload(riz, first!.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    assert.equal(complete(), 0, "ANNA still has a line to record");
    const res = await upload(riz, last!.id);
    await t.ctx.jobs.idle();
    assert.equal(complete(), 1, "the last take completes the cast, no render needed");
    const takeId = res.json().take.id as string;

    // Deleted by mistake, then put back: the restore completes the cast again.
    await resend(pid);
    assert.equal((await t.app.inject({ method: "DELETE", url: `/api/invite/takes/${takeId}`, headers: invite(riz.inviteUrl) })).statusCode, 200);
    await t.ctx.jobs.idle();
    assert.equal(complete(), 0);
    assert.equal((await t.app.inject({ method: "POST", url: `/api/invite/takes/${takeId}/restore`, headers: invite(riz.inviteUrl) })).statusCode, 200);
    await t.ctx.jobs.idle();
    assert.equal(complete(), 1, "putting the take back completes the cast");

    // The last line handed to BEN (nobody's part): ANNA's one remaining line is recorded.
    await resend(pid);
    await t.app.inject({ method: "DELETE", url: `/api/invite/takes/${takeId}`, headers: invite(riz.inviteUrl) });
    await t.ctx.jobs.idle();
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/api/lines/${last!.id}`,
      headers: bearer(director),
      payload: { characterId: chars.get("BEN") },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    await t.ctx.jobs.idle();
    assert.equal(complete(), 1, "a script edit that leaves every picked part recorded completes the cast");
  });
});
