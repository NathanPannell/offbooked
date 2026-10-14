import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { silentLog } from "../log.ts";
import { PiperSynthesizer } from "./piper.ts";
import { assignVoices, clipHash, guessGender, speakable, VOICES } from "./voices.ts";

const chars = (names: string[]) => names.map((name) => ({ id: randomUUID(), name }));

test("voice assignment is stable and distinct", () => {
  const cast = chars(["HAMLET", "HORATIO", "MARCELLUS", "POLONIUS", "LAERTES", "BERNARDO"]);
  const first = assignVoices(cast);
  assert.deepEqual(assignVoices(cast), first, "same characters, same voices");
  assert.equal(new Set([...first.values()].map((v) => v.id)).size, cast.length, "different characters, different voices");

  // A character added later (and so last in creation order) never moves an existing voice.
  const grown = assignVoices([...cast, ...chars(["GHOST", "OSRIC", "FRANCISCO"])]);
  for (const c of cast) assert.equal(grown.get(c.id)!.id, first.get(c.id)!.id);

  // Renaming keeps the voice (it hangs off the id) unless the new name implies another gender.
  const renamed = assignVoices(cast.map((c, i) => (i === 1 ? { ...c, name: "HORATIO (FRIEND)" } : c)));
  assert.equal(renamed.get(cast[1]!.id)!.id, first.get(cast[1]!.id)!.id);
});

test("titles in a name pick a fitting voice, and voices are reused only when they run out", () => {
  assert.equal(guessGender("QUEEN"), "f");
  assert.equal(guessGender("LADY MACBETH"), "f");
  assert.equal(guessGender("FIRST SOLDIER"), "m");
  assert.equal(guessGender("KING"), "m");
  assert.equal(guessGender("HORATIO"), null);
  const [queen, king] = chars(["QUEEN", "KING"]);
  const v = assignVoices([queen!, king!]);
  assert.equal(v.get(queen!.id)!.gender, "f");
  assert.equal(v.get(king!.id)!.gender, "m");

  const crowd = chars(Array.from({ length: VOICES.length + 5 }, (_, i) => `CITIZEN ${i}`));
  const many = assignVoices(crowd);
  assert.equal(new Set(crowd.slice(0, VOICES.length).map((c) => many.get(c.id)!.id)).size, VOICES.length);
  assert.ok(crowd.every((c) => many.get(c.id)));
});

test("spoken text drops bracketed directions and markup and joins verse lines", () => {
  assert.equal(speakable("[Aside.] A little more than kin,\n  and less than kind."), "A little more than kin, and less than kind.");
  assert.equal(speakable("_Exit._ Farewell {beat} now"), "Exit. Farewell now");
  assert.equal(speakable("—"), "");
  assert.equal(speakable("[Exit.]"), "");
});

test("TTS cache key covers text, voice, engine and settings", () => {
  const [a, b] = [VOICES[0]!, VOICES[5]!];
  const key = clipHash("piper 1.2.0", a, "Hail to your lordship!");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(clipHash("piper 1.2.0", a, "Hail to your lordship!"), key, "deterministic");
  assert.notEqual(clipHash("piper 1.2.0", a, "Hail to your lordship"), key, "text");
  assert.notEqual(clipHash("piper 1.2.0", b, "Hail to your lordship!"), key, "voice");
  assert.notEqual(clipHash("piper 1.3.0", a, "Hail to your lordship!"), key, "engine");
  const vctk = VOICES.filter((v) => v.model === "en_GB-vctk-medium");
  assert.notEqual(clipHash("piper 1.2.0", vctk[0]!, "x"), clipHash("piper 1.2.0", vctk[1]!, "x"), "speaker within a model");
  // Whitespace and brackets are cleaned before hashing, so cosmetic edits reuse the clip.
  assert.equal(speakable("Hail to  your\nlordship!"), speakable("[Bowing.] Hail to your lordship!"));
});

test("Piper reports itself unavailable when the binary or voices are missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-piper-"));
  try {
    const piper = new PiperSynthesizer({ bin: path.join(dir, "no-piper"), voicesDir: dir, maxProcs: 1, log: silentLog });
    assert.equal(await piper.probe(), null);
    await piper.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
