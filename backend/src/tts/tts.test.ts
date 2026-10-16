import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { silentLog } from "../log.ts";
import { PiperSynthesizer, pooledProcs } from "./piper.ts";
import { assignVoices, clipHash, guessGender, NARRATOR, NARRATOR_VOICE_ID, speakable, speakableDirection, spokenParts, TTS_SETTINGS, VOICE_MODELS, VOICES } from "./voices.ts";
import { joinWavs } from "./wav.ts";
import { toneWav } from "../test/tts.ts";

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
  const characterVoices = VOICES.length - 1; // all but the narrator
  assert.equal(new Set(crowd.slice(0, characterVoices).map((c) => many.get(c.id)!.id)).size, characterVoices);
  assert.ok(crowd.every((c) => many.get(c.id)));
});

test("the narrator's voice is reserved: no character ever gets it", () => {
  assert.equal(NARRATOR.id, NARRATOR_VOICE_ID);
  const crowd = chars(Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? `LADY ${i}` : i % 3 === 1 ? `LORD ${i}` : `CITIZEN ${i}`)));
  const voices = assignVoices(crowd);
  assert.ok([...voices.values()].every((v) => v.id !== NARRATOR_VOICE_ID));
  // Reserving it moves only a character that would have had it (and possibly those after it):
  // everyone before the first such character keeps the voice they had before.
  const cast = chars(["HAMLET", "HORATIO", "QUEEN", "KING", "OPHELIA", "POLONIUS", "LAERTES", "GHOST"]);
  const unreserved = assignVoices(cast, VOICES.map((v) => (v.id === NARRATOR_VOICE_ID ? { ...v, id: "unreserved" } : v)));
  const reserved = assignVoices(cast);
  for (const c of cast) {
    if (unreserved.get(c.id)!.id === "unreserved") break;
    assert.equal(reserved.get(c.id)!.id, unreserved.get(c.id)!.id);
  }
});

test("stage directions are read without their brackets; asides inside dialogue are dropped", () => {
  assert.equal(speakableDirection("[Flourish. Enter Claudius, King of Denmark,\n  Gertrude the Queen.]"), "Flourish. Enter Claudius, King of Denmark,\nGertrude the Queen.");
  assert.equal(speakableDirection("_Exit._"), "Exit.");
  assert.equal(speakableDirection("[ ]"), "");
  assert.equal(speakable("Now go. [To the Servant.] Was it not"), "Now go. Was it not");
  assert.equal(speakable("Stay, I say. [Enter the Ghost\nand more"), "Stay, I say.\nand more");
});

test("Piper keeps one process per model, so alternating voices never reload a model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-piper-"));
  try {
    // A stand-in for the piper binary: logs each start, answers --version and --json-input.
    const fake = path.join(dir, "fake-piper.mjs");
    const starts = path.join(dir, "starts.log");
    await writeFile(
      fake,
      `import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("1.2.0"); process.exit(0); }
appendFileSync(${JSON.stringify(starts)}, args[args.indexOf("-m") + 1] + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { output_file } = JSON.parse(line);
  writeFileSync(output_file, "RIFF");
  console.log(output_file);
});
`,
    );
    for (const m of VOICE_MODELS) {
      await writeFile(path.join(dir, `${m}.onnx`), "");
      await writeFile(path.join(dir, `${m}.onnx.json`), "{}");
    }
    const piper = new PiperSynthesizer({ bin: process.execPath, binArgs: [fake], voicesDir: dir, maxProcs: pooledProcs(2), log: silentLog });
    assert.equal(await piper.probe(), "piper 1.2.0");
    const byModel = VOICE_MODELS.map((m) => VOICES.find((v) => v.model === m)!);
    // A scene where three speakers on three models take turns, twice over.
    for (let i = 0; i < 9; i++) await piper.synthesize(`line ${i}`, byModel[i % 3]!, path.join(dir, `out-${i}.wav`));
    await piper.close();
    const started = (await readFile(starts, "utf8")).trim().split("\n");
    assert.equal(started.length, 3, `one start per model, got ${started.length}`);
    assert.equal(piper.started, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spoken text drops bracketed directions and markup and keeps each printed line", () => {
  assert.equal(speakable("[Aside.] A little more than kin,\n  and less than kind."), "A little more than kin,\nand less than kind.");
  assert.equal(speakable("To be, or not\n\n   —\nto be"), "To be, or not\nto be", "blank and wordless lines go");
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
  // Spaces and brackets are cleaned before hashing, so cosmetic edits reuse the clip. A line break
  // is a pause, so it counts.
  assert.equal(speakable("Hail to  your lordship! "), speakable("[Bowing.] Hail to your lordship!"));
  assert.notEqual(speakable("Hail to your\nlordship!"), speakable("Hail to your lordship!"));
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

test("a line splits into the character's words and the narrator's directions, in order", () => {
  assert.deepEqual(spokenParts("Now go. [To the Servant.] Was it not"), [
    { narrator: false, text: "Now go." },
    { narrator: true, text: "To the Servant." },
    { narrator: false, text: "Was it not" },
  ]);
  assert.deepEqual(spokenParts("[Aside.] A little more than kin,\n  and less than kind."), [
    { narrator: true, text: "Aside." },
    { narrator: false, text: "A little more than kin,\nand less than kind." },
  ]);
  // A direction closed on a later printed line, and one never closed (it ends with its line).
  assert.deepEqual(spokenParts("Go. [He blots and folds\nthe letter.] Splendid."), [
    { narrator: false, text: "Go." },
    { narrator: true, text: "He blots and folds\nthe letter." },
    { narrator: false, text: "Splendid." },
  ]);
  assert.deepEqual(spokenParts("Stay. [Enter the Ghost\nand more"), [
    { narrator: false, text: "Stay." },
    { narrator: true, text: "Enter the Ghost" },
    { narrator: false, text: "and more" },
  ]);
  assert.deepEqual(spokenParts("— [ ] —"), []);
});

test("printed lines are joined with a pause between them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-wav-"));
  try {
    const parts = [path.join(dir, "a.wav"), path.join(dir, "b.wav")];
    await writeFile(parts[0]!, toneWav(0.5, 300));
    await writeFile(parts[1]!, toneWav(0.25, 300));
    const out = path.join(dir, "out.wav");
    await joinWavs(parts, TTS_SETTINGS.lineBreakMs, out);
    const wav = await readFile(out);
    const gap = Math.round((22_050 * TTS_SETTINGS.lineBreakMs) / 1000);
    assert.equal(wav.readUInt32LE(40) / 2, Math.round(22_050 * 0.5) + Math.round(22_050 * 0.25) + gap);
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    await writeFile(parts[1]!, toneWav(0.25, 300, 16_000));
    await assert.rejects(joinWavs(parts, 300, out), /differ in format/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
