import assert from "node:assert/strict";
import { test } from "node:test";
import { silentLog } from "../log.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { alignToSource, NOT_FOUND } from "./align.ts";
import { chunkScript } from "./chunk.ts";
import { heuristicParse, parseHeading, splitInlineDirections } from "./heuristic.ts";
import { toParsedLines, type ChunkParser } from "./llm.ts";
import { parseScriptText } from "./pipeline.ts";
import { buildStructure, isAbbreviation, resolveCharacters, validateStructure } from "./structure.ts";
import type { ParsedLine } from "./types.ts";

const dialogue = (speaker: string, text: string, asWritten: string | null = null): ParsedLine => ({
  kind: "dialogue",
  speaker,
  speakerAsWritten: asWritten,
  text,
  act: null,
  scene: null,
  flagReason: null,
});

test("heuristic parser reads a Shakespeare scene", () => {
  const s = buildStructure(heuristicParse(SEED_SCENE));
  assert.deepEqual(validateStructure(s), []);
  assert.deepEqual(s.sections, [{ act: "1", scene: "2", title: "Act 1, Scene 2" }]);
  const names = s.characters.map((c) => c.name).sort();
  assert.deepEqual(names, ["HAMLET", "HORATIO", "KING", "LAERTES", "MARCELLUS", "POLONIUS", "QUEEN"]);
  assert.deepEqual(s.characters.find((c) => c.name === "HAMLET")!.aliases, ["HAM"]);
  const spoken = s.lines.filter((l) => l.kind === "dialogue");
  assert.equal(spoken.length, 36);
  assert.ok(spoken.every((l) => l.character));
  assert.equal(spoken[0]!.text.startsWith("Though yet of Hamlet our dear brother's death The memory be green"), true);
  const aside = s.lines.findIndex((l) => l.text === "[Aside.]");
  assert.equal(s.lines[aside]!.kind, "stage_direction");
  assert.equal(s.lines[aside + 1]!.text, "A little more than kin, and less than kind.");
  assert.ok(s.lines.some((l) => l.kind === "stage_direction" && l.text === "[Flourish. Exeunt all but Hamlet.]"));
  assert.equal(s.lines.filter((l) => l.kind === "heading").length, 2);
});

test("heuristic parser handles screenplay cues, parentheticals and colon cues", () => {
  const screenplay = `INT. KITCHEN - NIGHT

Rain against the window.

MAYA
(whispering)
Did you hear that?

JONAH (O.S.)
It's just the wind.

MAYA
It isn't.

EXT. GARDEN - CONTINUOUS

JONAH
Told you.`;
  const s = buildStructure(heuristicParse(screenplay));
  assert.deepEqual(validateStructure(s), []);
  assert.deepEqual(s.sections.map((x) => x.title), ["INT. KITCHEN - NIGHT", "EXT. GARDEN - CONTINUOUS"]);
  assert.deepEqual(
    s.lines.map((l) => [l.kind, l.character, l.text]),
    [
      ["heading", null, "INT. KITCHEN - NIGHT"],
      ["stage_direction", null, "Rain against the window."],
      ["stage_direction", null, "(whispering)"],
      ["dialogue", "MAYA", "Did you hear that?"],
      ["dialogue", "JONAH", "It's just the wind."],
      ["dialogue", "MAYA", "It isn't."],
      ["heading", null, "EXT. GARDEN - CONTINUOUS"],
      ["dialogue", "JONAH", "Told you."],
    ],
  );
  assert.ok(s.lines[1]!.flagReason, "unattributed text is flagged");

  const modern = `Sam: Are you coming? (She picks up her keys.)\nAlex: In a minute.\nSam: Fine.`;
  const m = buildStructure(heuristicParse(modern)).lines.map((l) => [l.kind, l.character, l.text]);
  assert.deepEqual(m, [
    ["dialogue", "SAM", "Are you coming?"],
    ["stage_direction", null, "(She picks up her keys.)"],
    ["dialogue", "ALEX", "In a minute."],
    ["dialogue", "SAM", "Fine."],
  ]);
});

test("headings and inline directions", () => {
  assert.deepEqual(parseHeading("ACT II"), { act: "2", scene: null });
  assert.deepEqual(parseHeading("Act Three, Scene 4"), { act: "3", scene: "4" });
  assert.deepEqual(parseHeading("II.iii"), { act: "2", scene: "3" });
  assert.equal(parseHeading("Act now, or we lose everything!"), null);
  assert.deepEqual(splitInlineDirections("Go. [Exit] Stay."), [
    { kind: "dialogue", text: "Go." },
    { kind: "stage_direction", text: "[Exit]" },
    { kind: "dialogue", text: "Stay." },
  ]);
});

test("character names merge abbreviations and flag doubtful or ambiguous ones", () => {
  assert.equal(isAbbreviation("HAM", "HAMLET"), true);
  assert.equal(isAbbreviation("LADY M", "LADY MACBETH"), true);
  assert.equal(isAbbreviation("KING", "HAMLET"), false);
  const lines = [
    dialogue("HAMLET", "a"),
    dialogue("HAMLET", "b", "HAM."),
    dialogue("CLAUDIUS", "c", "KING"),
    dialogue("CLAUDIUS", "d", "KING"),
    dialogue("LADY", "e"),
    dialogue("LADY MACBETH", "f"),
    dialogue("LADY MACDUFF", "g"),
  ];
  const r = resolveCharacters(lines);
  assert.deepEqual(r.characters.find((c) => c.name === "HAMLET")!.aliases, ["HAM"]);
  assert.deepEqual(r.characters.find((c) => c.name === "CLAUDIUS")!.aliases, ["KING"]);
  assert.equal(r.flagFor(lines[1]!, 1), null);
  assert.match(r.flagFor(lines[2]!, 2)!, /cued KING were assigned to CLAUDIUS/);
  assert.equal(r.flagFor(lines[3]!, 3), null, "a doubtful mapping is flagged once");
  assert.match(r.flagFor(lines[4]!, 4)!, /could be LADY MACBETH or LADY MACDUFF/);
});

test("alignment re-inserts dropped source text and flags invented text", () => {
  const source = "HAMLET. To be, or not to be.\nThe Ghost crosses the stage slowly and vanishes.\nOPHELIA. Good my lord.";
  const out = alignToSource(source, [dialogue("HAMLET", "To be, or not to be."), dialogue("OPHELIA", "Good my lord."), dialogue("OPHELIA", "Something never written.")], [
    "HAMLET",
    "OPHELIA",
  ]);
  assert.equal(out.lines.length, 4);
  assert.equal(out.lines[1]!.kind, "stage_direction");
  assert.equal(out.lines[1]!.text, "The Ghost crosses the stage slowly and vanishes.");
  assert.ok(out.lines[1]!.flagReason);
  assert.equal(out.lines[3]!.flagReason, NOT_FOUND);
  assert.ok(out.droppedChars > 30);

  const clean = alignToSource("HAM. Words, words, words.", [dialogue("HAMLET", "Words, words, words.", "HAM.")], ["HAMLET", "HAM."]);
  assert.equal(clean.droppedChars, 0);
  assert.equal(clean.lines[0]!.flagReason, null);
});

test("chunking keeps order, prefers scene breaks and passes context", () => {
  const scene = (n: number) => `SCENE ${n}\n\n${Array.from({ length: 40 }, (_, i) => `A${n}. line ${i} of scene ${n} with some words`).join("\n\n")}`;
  const text = [1, 2, 3, 4].map(scene).join("\n\n");
  const chunks = chunkScript(text, 2500);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.map((c) => c.text).join("\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  assert.equal(chunks[0]!.context, "");
  assert.ok(chunks[1]!.context.length > 0);
  assert.ok(chunks.some((c, i) => i > 0 && c.text.startsWith("SCENE")));
});

test("LLM output is checked against the schema", () => {
  assert.throws(() => toParsedLines({ nope: [] }));
  assert.throws(() => toParsedLines({ lines: [{ kind: "song", text: "x" }] }));
  const [line] = toParsedLines({ lines: [{ kind: "dialogue", speaker: "HAMLET", speakerAsWritten: "Ham.", text: "Hi", act: null, scene: null, uncertain: true, note: "maybe Horatio" }] });
  assert.equal(line!.flagReason, "maybe Horatio");
});

test("pipeline uses the chunk parser, retries once, then falls back to the heuristic parser", async () => {
  let calls = 0;
  const good: ChunkParser = async ({ chunk }) => {
    calls++;
    return { lines: heuristicParse(chunk.text), usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 } };
  };
  const ok = await parseScriptText(SEED_SCENE, { chunkParser: good, log: silentLog });
  assert.equal(ok.usage.parser, "llm");
  assert.equal(ok.usage.model, "claude-haiku-5-5");
  assert.equal(ok.usage.inputTokens, 10 * calls);
  assert.equal(ok.structure.lines.filter((l) => l.kind === "dialogue").length, 36);

  calls = 0;
  const failing: ChunkParser = async () => {
    calls++;
    throw new Error("boom");
  };
  const fallback = await parseScriptText(SEED_SCENE, { chunkParser: failing, log: silentLog });
  assert.equal(calls, 2, "one retry, never a different model");
  assert.equal(fallback.usage.parser, "heuristic");
  assert.ok(fallback.structure.lines.every((l) => l.flagReason), "fallback lines are all flagged");

  calls = 0;
  const lossy: ChunkParser = async () => {
    calls++;
    return { lines: [dialogue("KING", "Though yet of Hamlet our dear brother's death")], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
  };
  const rejected = await parseScriptText(SEED_SCENE, { chunkParser: lossy, log: silentLog });
  assert.equal(calls, 2, "output that drops most of the source fails validation and is retried");
  assert.equal(rejected.usage.fallbackChunks, 1);
});
