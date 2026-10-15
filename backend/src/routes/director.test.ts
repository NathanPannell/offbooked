import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

describe("productions, script corrections and cast", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let pid: string;
  let script: {
    lines: { id: string; seq: number; kind: string; characterId: string | null; text: string; sectionId: string; flagged: boolean }[];
    characters: { id: string; name: string; aliases: string[]; lineCount: number }[];
    sections: { id: string }[];
  };
  const char = (name: string) => script.characters.find((c) => c.name === name)!;
  const get = (url: string, token = alice) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const send = (method: "POST" | "PATCH", url: string, payload: object = {}, token = alice) => t.app.inject({ method, url, headers: bearer(token), payload });
  const reload = async () => {
    script = (await get(`/api/productions/${pid}/script`)).json();
  };

  before(async () => {
    t = await createTestApp();
    alice = await signIn(t, "alice@example.test");
    bob = await signIn(t, "bob@example.test");
    ({ id: pid, script } = await productionWithScript(t, alice, SEED_SCENE, "Hamlet"));
  });
  after(() => t.close());

  test("create, list, update and parse a production", async () => {
    const p = (await get(`/api/productions/${pid}`)).json().production;
    assert.equal(p.title, "Hamlet");
    assert.equal(p.scriptStatus, "ready");
    assert.equal(p.archived, false);
    assert.deepEqual(p.progress, { linesTotal: 36, linesRecorded: 0, actorsTotal: 0, actorsDone: 0 });
    const updated = (await send("PATCH", `/api/productions/${pid}`, { performanceDate: "2027-05-01" })).json().production;
    assert.equal(updated.performanceDate, "2027-05-01");
    assert.equal(updated.title, "Hamlet");
    assert.equal((await get("/api/productions")).json().productions.length, 1);
    const full = (await get(`/api/productions/${pid}/script`)).json();
    assert.equal(full.status, "ready");
    assert.equal(full.error, null);
    assert.equal(full.flaggedCount, full.lines.filter((l: { flagged: boolean }) => l.flagged).length);
    assert.deepEqual(full.lines.map((l: { seq: number }) => l.seq), full.lines.map((_: unknown, i: number) => i + 1));
    const [stored] = await t.ctx.sql`select storage_key, parser from scripts where production_id = ${pid}`;
    assert.equal(stored!.parser, "heuristic");
    assert.ok(await t.ctx.storage.exists(stored!.storageKey), "raw upload is stored");
  });

  test("another director cannot see or touch the production", async () => {
    assert.equal((await get("/api/productions", bob)).json().productions.length, 0);
    const line = script.lines.find((l) => l.kind === "dialogue")!;
    const attempts = [
      get(`/api/productions/${pid}`, bob),
      get(`/api/productions/${pid}/script`, bob),
      get(`/api/productions/${pid}/cast`, bob),
      get(`/api/productions/${pid}/runthrough`, bob),
      send("PATCH", `/api/productions/${pid}`, { title: "Mine" }, bob),
      send("POST", `/api/productions/${pid}/archive`, {}, bob),
      send("POST", `/api/productions/${pid}/script`, { text: "A: hi" }, bob),
      send("POST", `/api/productions/${pid}/render`, {}, bob),
      send("PATCH", `/api/lines/${line.id}`, { text: "hijacked" }, bob),
      send("POST", `/api/lines/${line.id}/split`, { at: 3 }, bob),
      send("POST", `/api/lines/${line.id}/resolve`, {}, bob),
      send("PATCH", `/api/sections/${script.sections[0]!.id}`, { title: "x" }, bob),
      send("PATCH", `/api/characters/${char("KING").id}`, { name: "x" }, bob),
      send("POST", `/api/productions/${pid}/cast`, { name: "Eve", characterIds: [] }, bob),
    ];
    for (const res of await Promise.all(attempts)) assert.equal(res.statusCode, 404, res.body);
    assert.equal((await get(`/api/productions/not-a-uuid`)).statusCode, 404);
  });

  test("line corrections", async () => {
    const line = script.lines.find((l) => l.kind === "dialogue" && l.text.startsWith("Have you your father's leave?"))!;
    const reassigned = (await send("PATCH", `/api/lines/${line.id}`, { characterId: char("QUEEN").id })).json().line;
    assert.equal(reassigned.characterId, char("QUEEN").id);
    const direction = (await send("PATCH", `/api/lines/${line.id}`, { kind: "stage_direction" })).json().line;
    assert.equal(direction.characterId, null);
    // One tap from direction to dialogue: the speaker of the dialogue line before it.
    const previousSpeaker = script.lines.filter((l) => l.seq < line.seq && l.kind === "dialogue").at(-1)!.characterId;
    const backToDialogue = (await send("PATCH", `/api/lines/${line.id}`, { kind: "dialogue" })).json().line;
    assert.equal(backToDialogue.characterId, previousSpeaker);
    // …or the character whose cue opens the text, with the cue removed.
    await send("PATCH", `/api/lines/${line.id}`, { kind: "stage_direction" });
    const cued = (await send("PATCH", `/api/lines/${line.id}`, { kind: "dialogue", text: "HAMLET. A little more than kin" })).json().line;
    assert.equal(cued.characterId, char("HAMLET").id);
    assert.equal(cued.text, "A little more than kin");
    await send("PATCH", `/api/lines/${line.id}`, { kind: "dialogue", characterId: char("KING").id, text: "Have you your father's leave, Laertes? What says Polonius?" });

    const split = (await send("POST", `/api/lines/${line.id}/split`, { at: 38 })).json().lines;
    assert.deepEqual(split.map((l: { text: string }) => l.text), ["Have you your father's leave, Laertes?", "What says Polonius?"]);
    assert.equal(split[1].seq, split[0].seq + 1);
    assert.equal(split[0].id, line.id, "the first part keeps the line id");
    const merged = (await send("POST", `/api/lines/${line.id}/merge-next`)).json().line;
    assert.equal(merged.text, "Have you your father's leave, Laertes?\nWhat says Polonius?");
    // Split again, then join from the lower line upwards: the upper line keeps its id.
    const [, lower] = (await send("POST", `/api/lines/${line.id}/split`, { at: 38 })).json().lines;
    const joinedUp = (await send("POST", `/api/lines/${lower.id}/merge-previous`)).json().line;
    assert.equal(joinedUp.id, line.id);
    assert.equal(joinedUp.text, "Have you your father's leave, Laertes?\nWhat says Polonius?");
    // Undoing a join puts the lower line back as it was: its kind, flag and place in the source.
    const restored = (await send("POST", `/api/lines/${line.id}/split`, {
      at: 38,
      second: { kind: "stage_direction", characterId: line.characterId, flagged: true, flagCode: "speaker", flagReason: "Who speaks?", sourceLine: 41, sourcePage: 3 },
    })).json().lines[1];
    assert.equal(restored.kind, "stage_direction");
    assert.equal(restored.characterId, null);
    assert.equal(restored.flagged, true);
    assert.equal(restored.flagCode, "speaker");
    assert.equal(restored.flagReason, "Who speaks?");
    const badCode = { kind: "stage_direction", characterId: null, flagged: true, flagCode: "maybe" };
    assert.equal((await send("POST", `/api/lines/${line.id}/split`, { at: 10, second: badCode })).statusCode, 400);
    assert.equal(restored.sourceLine, 41);
    assert.equal(restored.page, 3);
    assert.equal((await send("POST", `/api/lines/${line.id}/split`, { at: 10, second: { kind: "dialogue", characterId: null } })).statusCode, 400);
    await send("POST", `/api/lines/${line.id}/merge-next`);
    await reload();
    const first = script.lines.find((l) => l.seq === 1)!;
    assert.equal((await send("POST", `/api/lines/${first.id}/merge-previous`)).statusCode, 400);
    await reload();
    assert.deepEqual(script.lines.map((l) => l.seq), script.lines.map((_, i) => i + 1));

    const flagged = script.lines.find((l) => l.flagged)!;
    assert.ok(["speaker", "missed_cue", "direction", "text", "heading", "backup"].includes((flagged as { flagCode?: string }).flagCode!), "flagged lines carry a standard code");
    const resolved = (await send("POST", `/api/lines/${flagged.id}/resolve`)).json().line;
    assert.deepEqual([resolved.flagged, resolved.flagCode, resolved.flagReason], [false, null, null]);
  });

  test("section breaks and renames", async () => {
    const at = script.lines.find((l) => l.text === "[Enter Horatio, Marcellus and Bernardo.]")!;
    const sections = (await send("POST", `/api/lines/${at.id}/section-break`, { title: "Horatio arrives", act: "1", scene: "2b" })).json().sections;
    assert.equal(sections.length, 2);
    assert.deepEqual(sections.map((s: { seq: number }) => s.seq), [1, 2]);
    await reload();
    const moved = script.lines.filter((l) => l.seq >= at.seq);
    assert.ok(moved.every((l) => l.sectionId === sections[1].id));
    const renamed = (await send("PATCH", `/api/sections/${sections[1].id}`, { title: "Enter Horatio" })).json().section;
    assert.equal(renamed.title, "Enter Horatio");
    // Breaking at a section's first line renames it instead of adding an empty section.
    const again = (await send("POST", `/api/lines/${at.id}/section-break`, { title: "Horatio" })).json().sections;
    assert.equal(again.length, 2);
    assert.equal(again[1].title, "Horatio");
  });

  test("characters: create, rename and merge", async () => {
    const created = await send("POST", `/api/productions/${pid}/characters`, { name: "GHOST" });
    assert.equal(created.json().character.lineCount, 0);
    assert.equal((await send("POST", `/api/productions/${pid}/characters`, { name: "ghost" })).statusCode, 409);
    const renamed = (await send("PATCH", `/api/characters/${char("KING").id}`, { name: "CLAUDIUS" })).json().character;
    assert.equal(renamed.name, "CLAUDIUS");
    assert.deepEqual(renamed.aliases, ["KING"]);
    const kingLines = renamed.lineCount;
    const merged = (await send("POST", `/api/characters/${char("POLONIUS").id}/merge`, { intoId: char("KING").id })).json().characters;
    const claudius = merged.find((c: { name: string }) => c.name === "CLAUDIUS");
    assert.equal(claudius.lineCount, kingLines + 1);
    assert.deepEqual(claudius.aliases, ["KING", "POLONIUS"]);
    assert.equal(merged.some((c: { name: string }) => c.name === "POLONIUS"), false);
    await reload();
  });

  test("cast members, invite links, reset and nudge", async () => {
    const res = await send("POST", `/api/productions/${pid}/cast`, { name: "Riz Ahmed", email: "riz@example.test", characterIds: [char("HAMLET").id] });
    const member = res.json().member;
    assert.match(member.inviteUrl, /^https:\/\/app\.test\/i\/[A-Za-z0-9_-]{22}\.1\.[A-Za-z0-9_-]{22}$/);
    assert.equal(member.status, "not_opened");
    assert.equal(member.linesTotal, char("HAMLET").lineCount);
    assert.equal(member.linesRecorded, 0);
    assert.equal(member.avgAccuracy, null);

    const doubled = (await send("POST", `/api/productions/${pid}/cast`, { name: "Jo", characterIds: [char("QUEEN").id, char("HORATIO").id] })).json().member;
    assert.equal(doubled.characterIds.length, 2);
    // Giving HORATIO to someone else takes it from Jo.
    await send("PATCH", `/api/cast/${member.id}`, { characterIds: [char("HAMLET").id, char("HORATIO").id], phone: "+1 555 0100" });
    const cast = (await get(`/api/productions/${pid}/cast`)).json();
    assert.deepEqual(cast.cast.find((m: { id: string }) => m.id === doubled.id).characterIds, [char("QUEEN").id]);
    assert.equal(cast.cast.find((m: { id: string }) => m.id === member.id).phone, "+1 555 0100");
    assert.ok(cast.uncastCharacterIds.includes(char("LAERTES").id));
    assert.ok(!cast.uncastCharacterIds.includes(char("HORATIO").id));

    const reset = (await send("POST", `/api/cast/${member.id}/reset-link`)).json().member;
    assert.notEqual(reset.inviteUrl, member.inviteUrl);
    assert.match(reset.inviteUrl, /\.2\./);
    const nudged = (await send("POST", `/api/cast/${member.id}/nudged`)).json().member;
    assert.ok(nudged.nudgedAt);
    assert.equal((await get(`/api/productions/${pid}`)).json().production.progress.actorsTotal, 2);
  });

  test("bad script uploads are refused with a plain message", async () => {
    const created = (await send("POST", "/api/productions", { title: "Empty" })).json().production;
    const notPdf = await t.app.inject({
      method: "POST",
      url: `/api/productions/${created.id}/script`,
      headers: { ...bearer(alice), "content-type": "multipart/form-data; boundary=x" },
      payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\nhello\r\n--x--\r\n',
    });
    assert.equal(notPdf.statusCode, 415);
    const empty = await send("POST", `/api/productions/${created.id}/script`, { text: "  " });
    assert.equal(empty.statusCode, 400);
  });

  test("archiving hides a production", async () => {
    const created = (await send("POST", "/api/productions", { title: "Old show" })).json().production;
    assert.equal((await send("POST", `/api/productions/${created.id}/archive`)).statusCode, 204);
    const list = (await get("/api/productions")).json().productions;
    assert.ok(!list.some((p: { id: string }) => p.id === created.id));
    assert.equal((await get(`/api/productions/${created.id}`)).json().production.archived, true);
  });
});
