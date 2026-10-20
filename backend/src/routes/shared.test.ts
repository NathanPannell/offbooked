import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTone } from "../render/ffmpeg.ts";
import { buildEnsemblePrompt, parseEnsembleReply, type EnsembleRequest } from "../shared.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

const SCRIPT = `ACT I

SCENE I. The court.

ANGELO. We must not make a scarecrow of the law.

ESCALUS. Ay, but yet let us be keen.

ELBOW. Come, bring them away.

ANGELO, ESCALUS. Benefactors? Well, what benefactors are they?

[Exit ELBOW.]

ALL. Be it as your wisdom will.

ANGELO. See that Claudio be executed by nine tomorrow morning.
`;

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
  voiceIds: string[] | null;
  text: string;
}
interface Character {
  id: string;
  name: string;
  group: boolean;
  everyone: boolean;
  memberIds: string[];
  lineCount: number;
}

describe("shared lines", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let pid: string;
  let lines: Line[];
  let chars: Map<string, Character>;
  let wav: Buffer;
  let angeloToken = "";
  let escalusToken = "";
  const asks: EnsembleRequest[] = [];
  const get = (url: string, token = director) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const script = async () => (await get(`/api/productions/${pid}/script`)).json() as { lines: Line[]; characters: Character[] };
  const id = (name: string) => chars.get(name)!.id;
  const upload = (token: string, lineId: string) =>
    t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: { authorization: `Invite ${token}`, "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });
  const claim = async (firstName: string, names: string[]) => {
    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`)).json();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName, characterIds: names.map(id) },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().inviteToken as string;
  };

  before(async () => {
    // Claude, faked: whoever is still on stage says the ALL line (Elbow has gone).
    t = await createTestApp({
      ensemble: async (req) => {
        asks.push(req);
        return Object.fromEntries(req.targets.map((n) => [n, ["ANGELO", "ESCALUS"]]));
      },
    });
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
    director = await signIn(t, "director@example.test");
    const made = await productionWithScript(t, director, SCRIPT, "Measure for Measure");
    pid = made.id;
    // The backup parser doesn't read "ANGELO, ESCALUS." as a cue (Claude does): name the speakers
    // by hand, the way a director would in review.
    const pair = await t.app.inject({
      method: "POST",
      url: `/api/productions/${pid}/characters`,
      headers: bearer(director),
      payload: { name: "ANGELO, ESCALUS" },
    });
    const benefactors = made.script.lines.find((l: Line) => l.text.includes("Benefactors"))!;
    const fixed = await t.app.inject({
      method: "PATCH",
      url: `/api/lines/${benefactors.id}`,
      headers: bearer(director),
      payload: { kind: "dialogue", characterId: pair.json().character.id, text: "Benefactors? Well, what benefactors are they?" },
    });
    assert.equal(fixed.statusCode, 200, fixed.body);
    await t.ctx.jobs.idle();
    ({ lines } = await script());
    chars = new Map((await script()).characters.map((c) => [c.name, c]));
  });
  after(() => t.close());

  const byText = (start: string) => lines.find((l) => l.text.startsWith(start))!;

  test("a character named after others is a group, and its lines are said by each of them", () => {
    const pair = chars.get("ANGELO, ESCALUS")!;
    assert.equal(pair.group, true);
    assert.deepEqual(pair.memberIds, [id("ANGELO"), id("ESCALUS")]);
    assert.deepEqual(byText("Benefactors").voiceIds, [id("ANGELO"), id("ESCALUS")]);
    assert.equal(byText("We must").voiceIds, null, "single lines keep one voice");
    assert.equal(chars.get("ANGELO")!.lineCount, 4, "shared lines count for each voice");
  });

  test("Claude reads the scene for who says ALL, replacing the whole-scene guess", () => {
    const all = chars.get("ALL")!;
    assert.equal(all.everyone, true);
    assert.ok(asks.length >= 1);
    const ask = asks[0]!;
    assert.ok(ask.characters.includes("ELBOW") && !ask.characters.includes("ALL"), "groups aren't offered as speakers");
    assert.ok(
      ask.scene.some((row) => row.includes("Exit ELBOW")),
      "the scene includes its directions",
    );
    assert.match(buildEnsemblePrompt(ask), /Target rows: \d+ \(ALL\)/);
    assert.deepEqual(byText("Be it as").voiceIds, [id("ANGELO"), id("ESCALUS")]);
  });

  test("groups aren't parts on the call sheet or the cast link", async () => {
    const sheet = (await get(`/api/productions/${pid}/call-sheet`)).json().characters as { name: string; lineCount: number }[];
    assert.ok(!sheet.some((c) => c.name === "ALL" || c.name === "ANGELO, ESCALUS"));
    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`)).json();
    const join = (await t.app.inject({ method: "GET", url: `/api/join/${joinUrl.split("/join/")[1]}` })).json();
    assert.ok(!join.characters.some((c: { name: string }) => c.name === "ALL"));
  });

  test("each voice records a shared line, hears the others, and the line counts once every voice is in", async () => {
    const angelo = (angeloToken = await claim("Ana", ["ANGELO"]));
    const escalus = (escalusToken = await claim("Esc", ["ESCALUS"]));
    const shared = byText("Benefactors");
    const mine = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: { authorization: `Invite ${angelo}` } })).json();
    const item = mine.lines.find((l: { line: { id: string } }) => l.line.id === shared.id);
    assert.ok(item, "the shared line is in each voice's list");
    assert.deepEqual(
      item.together.map((x: { characterId: string; audioUrl: string | null }) => [x.characterId, x.audioUrl]),
      [[id("ESCALUS"), null]],
    );

    assert.equal((await upload(angelo, shared.id)).statusCode, 200);
    let sheet = (await get(`/api/productions/${pid}/call-sheet`)).json().characters as { name: string; linesRecorded: number }[];
    assert.equal(sheet.find((c) => c.name === "ANGELO")!.linesRecorded, 1);
    assert.equal(sheet.find((c) => c.name === "ESCALUS")!.linesRecorded, 0, "Angelo's take doesn't count for Escalus");
    let production = (await get(`/api/productions/${pid}`)).json().production;
    assert.equal(production.progress.linesRecorded, 0, "a shared line is recorded once every voice is in");

    const escLines = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: { authorization: `Invite ${escalus}` } })).json();
    const escItem = escLines.lines.find((l: { line: { id: string } }) => l.line.id === shared.id);
    assert.equal(escItem.take, null, "Angelo's take isn't Escalus's own");
    assert.ok(escItem.together[0].audioUrl, "Escalus can hear Angelo's take");

    assert.equal((await upload(escalus, shared.id)).statusCode, 200);
    production = (await get(`/api/productions/${pid}`)).json().production;
    assert.equal(production.progress.linesRecorded, 1);
    sheet = (await get(`/api/productions/${pid}/call-sheet`)).json().characters;
    assert.equal(sheet.find((c) => c.name === "ESCALUS")!.linesRecorded, 1);

    // Both takes play together as one mixed clip.
    const audio = (await get(`/api/productions/${pid}/lines/${shared.id}/audio`)).json();
    assert.equal(audio.source, "actor");
    assert.ok(audio.audioUrl.includes("/mixes/"), audio.audioUrl);
    assert.ok(audio.durationMs > 500);
  });

  test("a character's studio lists their shared lines with the others' takes", async () => {
    const res = await get(`/api/productions/${pid}/characters/${id("ESCALUS")}/lines`);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    const shared = body.lines.find((l: { line: { id: string } }) => l.line.id === byText("Benefactors").id);
    assert.equal(shared.characterName, "ESCALUS");
    assert.equal(shared.voiceId, id("ESCALUS"));
    assert.ok(shared.take, "Escalus's own take");
    assert.deepEqual(
      shared.together.map((x: { characterId: string }) => x.characterId),
      [id("ANGELO")],
    );
    assert.ok(
      body.lines.every((l: { line: { text: string } }) => !l.line.text.startsWith("We must")),
      "only lines Escalus says",
    );
  });

  test("the director picks who says a line: several names make a group", async () => {
    const line = byText("See that Claudio");
    const res = await t.app.inject({
      method: "PATCH",
      url: `/api/lines/${line.id}`,
      headers: bearer(director),
      payload: { voiceIds: [id("ESCALUS"), id("ELBOW")] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().line.voiceIds, [id("ESCALUS"), id("ELBOW")]);
    const after = await script();
    const group = after.characters.find((c) => c.id === res.json().line.characterId)!;
    assert.equal(group.name, "ESCALUS, ELBOW");
    assert.equal(group.group, true);

    // On an ALL line the pick replaces Claude's guess.
    const all = byText("Be it as");
    const pick = await t.app.inject({
      method: "PATCH",
      url: `/api/lines/${all.id}`,
      headers: bearer(director),
      payload: { voiceIds: [id("ELBOW"), id("ANGELO")] },
    });
    assert.deepEqual(pick.json().line.voiceIds, [id("ELBOW"), id("ANGELO")]);
    assert.equal(pick.json().line.characterId, id("ALL"));
  });

  test("merging a character moves its shared lines and its part", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/characters/${id("ELBOW")}/merge`,
      headers: bearer(director),
      payload: { intoId: id("ESCALUS") },
    });
    assert.equal(res.statusCode, 200, res.body);
    const after = await script();
    const allLine = after.lines.find((l) => l.text.startsWith("Be it as"))!;
    assert.deepEqual(allLine.voiceIds, [id("ESCALUS"), id("ANGELO")]);
    const claudio = after.lines.find((l) => l.text.startsWith("See that Claudio"))!;
    assert.equal(claudio.voiceIds, null, "ESCALUS, ESCALUS is just ESCALUS now");
  });

  test("an actor can fix their name", async () => {
    const froth = (
      await t.app.inject({ method: "POST", url: `/api/productions/${pid}/characters`, headers: bearer(director), payload: { name: "FROTH" } })
    ).json().character;
    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`)).json();
    const made = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName: "Mistyped", characterIds: [froth.id] },
    });
    const auth = { authorization: `Invite ${made.json().inviteToken}` };
    const res = await t.app.inject({ method: "PATCH", url: "/api/invite/me", headers: auth, payload: { name: "Frederica Smith" } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: auth })).json().actor.firstName, "Frederica");
    const cast = (await get(`/api/productions/${pid}/cast`)).json().cast as { name: string; characterIds: string[] }[];
    assert.equal(cast.find((a) => a.characterIds.includes(froth.id))!.name, "Frederica Smith");
    assert.equal((await t.app.inject({ method: "PATCH", url: "/api/invite/me", headers: auth, payload: { name: " " } })).statusCode, 400);
  });

  test("deleting a take falls back to the previous one, and Undo puts it back", async () => {
    const line = byText("We must");
    const record = () =>
      t.app.inject({
        method: "PUT",
        url: `/api/lines/${line.id}/take`,
        headers: { ...bearer(director), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
        payload: wav,
      });
    const first = (await record()).json().take.id;
    const second = (await record()).json().take.id;
    const current = async () =>
      (await t.ctx.sql<{ currentTakeId: string | null }[]>`select current_take_id from lines where id = ${line.id}`)[0]!.currentTakeId;
    assert.equal(await current(), second);
    assert.equal((await t.app.inject({ method: "DELETE", url: `/api/takes/${second}`, headers: bearer(director) })).statusCode, 204);
    assert.equal(await current(), first);
    assert.equal((await t.app.inject({ method: "DELETE", url: `/api/takes/${first}`, headers: bearer(director) })).statusCode, 204);
    assert.equal(await current(), null, "no takes left: the line goes back to TTS");
    assert.equal((await t.app.inject({ method: "POST", url: `/api/takes/${second}/restore`, headers: bearer(director) })).statusCode, 204);
    assert.equal(await current(), second);
  });

  test("an actor deletes their own take, and only their own", async () => {
    const shared = byText("Benefactors");
    const mine = async () =>
      (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: { authorization: `Invite ${angeloToken}` } }))
        .json()
        .lines.find((l: { line: { id: string } }) => l.line.id === shared.id).take as { id: string } | null;
    const take = (await mine())!;
    const recorded = async () => (await get(`/api/productions/${pid}`)).json().production.progress.linesRecorded as number;
    const before = await recorded();
    const del = await t.app.inject({ method: "DELETE", url: `/api/invite/takes/${take.id}`, headers: { authorization: `Invite ${angeloToken}` } });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(await mine(), null);
    assert.equal(await recorded(), before - 1, "the shared line isn't complete any more");
    const other = await t.app.inject({ method: "DELETE", url: `/api/invite/takes/${take.id}`, headers: { authorization: `Invite ${escalusToken}` } });
    assert.equal(other.statusCode, 404);
    const back = await t.app.inject({ method: "POST", url: `/api/invite/takes/${take.id}/restore`, headers: { authorization: `Invite ${angeloToken}` } });
    assert.equal(back.statusCode, 200);
    assert.equal((await mine())!.id, take.id);
  });

  test("the reply parser keeps only numbered name lists", () => {
    assert.deepEqual(parseEnsembleReply('Sure:\n{"3": ["ANNA", "BEN"], "x": ["C"], "5": "nope"}'), { 3: ["ANNA", "BEN"] });
    assert.deepEqual(parseEnsembleReply("no json"), {});
  });
});
