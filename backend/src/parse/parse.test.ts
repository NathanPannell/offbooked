import assert from "node:assert/strict";
import { test } from "node:test";
import { silentLog } from "../log.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { heuristicParse, parseHeading, splitInlineDirections } from "./heuristic.ts";
import { assembleSegments, joinLines, splitDirections, stripCue } from "./assemble.ts";
import { coverageProblem, parseRows, type Labeler, type Segment } from "./label.ts";
import { stripLineNumbers } from "./noise.ts";
import { chunkRanges, joinContinuations, parseScriptText, unifySpeakers, validPrefix } from "./pipeline.ts";
import { decodeText, detectSourceKind } from "./source.ts";
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

test("line numbers are stripped only when they run through the document", () => {
  const folger = Array.from({ length: 80 }, (_, i) => `FTLN ${String(i + 1).padStart(4, "0")} Line ${i + 1} of verse here${(i + 1) % 5 === 0 ? ` ${i + 1}` : ""}`).join("\n");
  const { text, report } = stripLineNumbers(folger);
  assert.equal(report.leadingPrefix, "FTLN");
  assert.equal(report.trailingCounters, 16);
  assert.equal(text.split("\n")[4], "Line 5 of verse here");
  const prose = Array.from({ length: 40 }, (_, i) => `ANNA. I paid 20 pounds for it in ${1890 + (i % 3)}.`).join("\n");
  assert.equal(stripLineNumbers(prose).text, prose, "numbers inside sentences survive");
});

test("label rows parse into segments and coverage is checked", () => {
  const segs = parseRows("1-3 X\n4 H act=1 scene=2\n5 S HAMLET | Ham. >> Aside. ?? maybe Horatio\n6-7 C\nnoise line\n8 D");
  assert.equal(segs.length, 5);
  assert.deepEqual([segs[1]!.act, segs[1]!.scene], ["1", "2"]);
  assert.deepEqual([segs[2]!.speaker, segs[2]!.cue, segs[2]!.inlineDirections, segs[2]!.note], ["HAMLET", "Ham.", ["Aside."], "maybe Horatio"]);
  const lines = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assert.equal(coverageProblem(segs, lines, 1, 8), null);
  assert.match(coverageProblem(segs.filter((s) => s.from !== 4), lines, 1, 8)!, /line 4/);
});

test("assembly strips cues and splits out inline directions", () => {
  assert.equal(stripCue("HAM. To be, or not to be", ["Ham.", "HAMLET"]), "To be, or not to be");
  assert.equal(stripCue("BARNARDO Who's there?", ["BARNARDO"]), "Who's there?");
  assert.equal(stripCue("Barnardo hath my place.", ["BARNARDO"]), "hath my place.", "a cue match is case-insensitive");
  assert.equal(joinLines(["some-", "thing here", "", "and more"]), "something here\nand more");
  assert.deepEqual(splitDirections("Give you good night. Francisco exits.", ["Francisco exits."]), [
    { text: "Give you good night.", direction: false },
    { text: "Francisco exits.", direction: true },
  ]);
  assert.deepEqual(splitDirections("[Aside] I'll do it (as I said) now.", []).map((p) => p.direction), [true, false]);
  assert.deepEqual(splitDirections("_Looking out anxiously._—Did you ask him?", []), [
    { text: "Looking out anxiously.", direction: true },
    { text: "Did you ask him?", direction: false },
  ]);
  assert.equal(splitDirections("my_var stays", []).length, 1);
  assert.deepEqual(splitDirections("I _do_ mean something else.", []), [{ text: "I do mean something else.", direction: false }]);
  assert.deepEqual(splitDirections("I'll do it (rising) now.", ["(rising)"]).map((p) => p.direction), [false, true, false]);

  const lines = ["Hamlet", "ACT 1", "BARNARDO", "Who's there?", "FRANCISCO Nay, answer me.", "Enter Horatio.", "and stand"];
  const segs = parseRows("1 X\n2 H act=1\n3-4 S BARNARDO | BARNARDO\n5 S FRANCISCO | FRANCISCO\n6 D\n7 C");
  const out = assembleSegments(segs, lines);
  assert.deepEqual(out.map((l) => [l.kind, l.speaker, l.text]), [
    ["heading", null, "ACT 1"],
    ["dialogue", "BARNARDO", "Who's there?"],
    ["dialogue", "FRANCISCO", "Nay, answer me."],
    ["stage_direction", null, "Enter Horatio."],
    ["dialogue", null, "and stand"],
  ]);
  assert.equal(out[4]!.continuation, true);
});

test("valid label prefixes are kept, small gaps patched, continuations joined, cues keep one name", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  const patched = validPrefix(parseRows("1-4 S A | A\n6-10 D"), lines, 1, 10);
  assert.equal(patched.next, 11);
  assert.equal(coverageProblem(patched.segments, lines, 1, 10), null);
  assert.equal(patched.segments[0]!.to, 5);
  const stopped = validPrefix(parseRows("1-4 S A | A\n9-10 D"), lines, 1, 10);
  assert.equal(stopped.next, 5, "a gap of four lines ends the valid run");

  const joined = joinContinuations([
    [{ kind: "dialogue", speaker: "A", speakerAsWritten: "A", text: "one", act: null, scene: null, flagReason: null }],
    [{ kind: "dialogue", speaker: null, speakerAsWritten: null, text: "two", act: null, scene: null, flagReason: null, continuation: true }],
  ]);
  assert.deepEqual(joined.map((l) => l.text), ["one\ntwo"]);

  const unified = unifySpeakers([dialogue("KING", "a", "King."), dialogue("KING", "b", "King."), dialogue("CLAUDIUS", "c", "King.")]);
  assert.deepEqual(unified.map((l) => l.speaker), ["KING", "KING", "KING"]);
  const shared = unifySpeakers([dialogue("SECOND PILGRIM", "a", "Sec."), dialogue("SECOND PILGRIM", "b", "Sec."), dialogue("SECOND OFFICER", "c", "Sec.")]);
  assert.deepEqual(shared.map((l) => l.speaker), ["SECOND PILGRIM", "SECOND PILGRIM", "SECOND OFFICER"]);
});

test("chunk ranges cover the document without overlap", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => (i % 50 === 0 ? `SCENE ${i / 50 + 1}` : i % 7 === 0 ? "" : `NAME. words ${i}`));
  const ranges = chunkRanges(lines);
  assert.ok(ranges.length >= 5);
  assert.equal(ranges[0]![0], 1);
  assert.equal(ranges[ranges.length - 1]![1], 1000);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]![0], ranges[i - 1]![1] + 1);
});

test("uploads are recognised by their bytes", () => {
  assert.equal(detectSourceKind(Buffer.from("%PDF-1.7 ...")), "pdf");
  assert.equal(detectSourceKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), "play.docx"), "docx");
  assert.equal(detectSourceKind(Buffer.from("HAMLET. Hi")), "text");
  assert.throws(() => detectSourceKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0]), "old.doc"), /\.doc/);
  assert.equal(decodeText(Buffer.from([0xe9])), "é", "invalid UTF-8 falls back to Windows-1252");
});

// A stand-in labeler that labels each line with the heuristic parser's view of it.
const fakeLabeler = (counter: { calls: number }): Labeler => async ({ lines, from, to }) => {
  counter.calls++;
  const rows: string[] = [];
  for (let n = from; n <= to; n++) {
    const l = lines[n - 1]!.trim();
    if (!l) continue;
    const cue = /^([A-Z][A-Z ]+)\.\s/.exec(l);
    if (/^(ACT|SCENE)\b/i.test(l)) rows.push(`${n} H`);
    else if (cue) rows.push(`${n} S ${cue[1]} | ${cue[1]}.`);
    else if (/^\[|^Enter|^Exit/.test(l)) rows.push(`${n} D`);
    else rows.push(`${n} C`);
  }
  return { segments: parseRows(rows.join("\n")), usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 } };
};

test("pipeline labels with the model, retries once, then falls back to the heuristic parser", async () => {
  const counter = { calls: 0 };
  const ok = await parseScriptText(SEED_SCENE, { labeler: fakeLabeler(counter), log: silentLog });
  assert.equal(ok.usage.parser, "llm");
  assert.equal(ok.usage.model, "claude-haiku-5-5");
  assert.equal(ok.usage.inputTokens, 10 * counter.calls);
  assert.ok(ok.structure.lines.filter((l) => l.kind === "dialogue").length >= 30);

  let calls = 0;
  const failing: Labeler = async () => {
    calls++;
    throw new Error("boom");
  };
  const fallback = await parseScriptText(SEED_SCENE, { labeler: failing, log: silentLog });
  assert.equal(calls, 4, "retries stay on the same model");
  assert.equal(fallback.usage.parser, "heuristic");
  assert.ok(fallback.structure.lines.every((l) => l.flagReason), "fallback lines are all flagged");

  calls = 0;
  const lossy: Labeler = async ({ from }) => {
    calls++;
    return { segments: parseRows(`${from} S KING | KING`), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
  };
  const rejected = await parseScriptText(SEED_SCENE, { labeler: lossy, log: silentLog });
  assert.equal(calls, 4, "labels that stop early are resumed from the first gap, up to four times");
  assert.equal(rejected.usage.fallbackChunks, 1);
});

test("a cue copied together with spoken words is trimmed to the name", async () => {
  const { cueName } = await import("./assemble.ts");
  assert.equal(cueName("BARNARDO Long live the King!"), "BARNARDO");
  assert.equal(cueName("Ham."), "Ham.");
  assert.equal(cueName("LADY MACBETH Out, damned spot!"), "LADY MACBETH");
  assert.equal(cueName("FIRST PLAYER"), "FIRST PLAYER");
  assert.equal(cueName("Algernon. How are you?"), "Algernon.");
  assert.equal(cueName("BARNARDO I have seen nothing."), "BARNARDO");
  const out = assembleSegments(parseRows("1 S BARNARDO | BARNARDO Long live the King!"), ["BARNARDO Long live the King!"]);
  assert.equal(out[0]!.text, "Long live the King!");
});

test("a cue left without words takes the speech the model labelled as a direction", () => {
  const lines = ["NORA.", "_In a low voice._—Where is she?", "[Nora sits.]"];
  const out = assembleSegments(parseRows("1 S NORA | NORA.\n2 D\n3 D"), lines);
  assert.deepEqual(out.map((l) => [l.kind, l.speaker, l.text]), [
    ["stage_direction", null, "In a low voice."],
    ["dialogue", "NORA", "Where is she?"],
    ["stage_direction", null, "[Nora sits.]"],
  ]);
});

test("cue lines the model merged are split out again, and a cue line's direction is kept apart", async () => {
  const { learnCues, lineCue, repairCues } = await import("./cues.ts");
  const { cueLineDirection } = await import("./assemble.ts");
  const lines = [
    "KING", "Have you your father's leave? What says Polonius?", "", "POLONIUS", "Hath, my lord, wrung from me my slow leave.",
    "KING", "Take thy fair hour, Laertes.", "HAMLET, aside", "A little more than kin and less than kind.", "HAMLET Not so, my lord.",
  ];
  const labelled = parseRows("1-5 S KING | KING\n6-7 S KING | KING\n8-9 S HAMLET | HAMLET\n10 S HAMLET | HAMLET");
  const book = learnCues([...labelled, ...parseRows("1 S POLONIUS | POLONIUS\n2 S POLONIUS | POLONIUS\n3 S POLONIUS | POLONIUS\n4 S HAMLET | HAMLET")]);
  assert.equal(lineCue("POLONIUS", book, ""), "POLONIUS");
  assert.equal(lineCue("HAMLET, aside", book, ""), "HAMLET");
  assert.equal(lineCue("KING of shreds and patches", book, "x"), null, "a capitalised word after the cue must start a sentence");
  const repaired = repairCues(labelled, lines, book);
  assert.deepEqual(repaired.map((s) => [s.from, s.to, s.speaker]), [[1, 3, "KING"], [4, 5, "POLONIUS"], [6, 7, "KING"], [8, 9, "HAMLET"], [10, 10, "HAMLET"]]);
  assert.equal(cueLineDirection("HAMLET, aside", ["HAMLET"]), "aside");
  assert.equal(cueLineDirection("HAMLET Not so", ["HAMLET"]), null);
  const out = assembleSegments(repaired, lines);
  assert.deepEqual(out.filter((l) => l.speaker === "HAMLET" || l.kind === "stage_direction").map((l) => l.text), ["aside", "A little more than kin and less than kind.", "Not so, my lord."]);
});

test("a cue line labelled as a direction claims the continuation after it", async () => {
  const { learnCues, repairCues } = await import("./cues.ts");
  const lines = ["LOMOV", "He is old.", "NATALYA", "There's some demon in you.", "NATALYA", "No.", "NATALYA", "Yes."];
  const segs = parseRows("1-2 S LOMOV | LOMOV\n3 D\n4 C\n5-6 S NATALYA | NATALYA\n7-8 S NATALYA | NATALYA");
  const book = learnCues([...segs, ...parseRows("1 S LOMOV | LOMOV\n2 S LOMOV | LOMOV\n3 S NATALYA | NATALYA")]);
  const out = assembleSegments(repairCues(segs, lines, book), lines);
  assert.deepEqual(out.map((l) => [l.speaker, l.text]), [["LOMOV", "He is old."], ["NATALYA", "There's some demon in you."], ["NATALYA", "No."], ["NATALYA", "Yes."]]);
});

test("spoken words reported as a cue are not trusted", async () => {
  const { trustedCue } = await import("./assemble.ts");
  assert.equal(trustedCue("Yes,", "NATALYA STEPANOVNA"), null);
  assert.equal(trustedCue("The", "LOMOV"), null);
  assert.equal(trustedCue("Ham.", "HAMLET"), "Ham.");
  assert.equal(trustedCue("Lady B.", "LADY BRACKNELL"), "Lady B.");
  assert.equal(trustedCue("KING", "CLAUDIUS"), "KING");
  assert.equal(trustedCue("Algernon.", "ALGERNON"), "Algernon.");
  const out = assembleSegments(parseRows("1-2 S NATALYA | Yes, the principle"), ["NATALYA", "Yes, the principle, just so."]);
  assert.equal(out[0]!.text, "Yes, the principle, just so.");
});

test("a cue at the end of one chunk owns the continuation at the start of the next", () => {
  const lines = ["MERRIMAN.", "Yes, Miss.", "ALGERNON.", "I hope, Cecily, I shall not offend you."];
  const first = assembleSegments(parseRows("1-2 S MERRIMAN | MERRIMAN.\n3 S ALGERNON | ALGERNON."), lines);
  const second = assembleSegments(parseRows("4 C"), lines);
  const joined = joinContinuations([first, second]);
  assert.deepEqual(joined.map((l) => [l.speaker, l.text]), [["MERRIMAN", "Yes, Miss."], ["ALGERNON", "I hope, Cecily, I shall not offend you."]]);
});

test("abbreviated cues of several words are stripped whole, without eating speech", async () => {
  const { bestCue } = await import("./assemble.ts");
  assert.equal(bestCue("Sec. Off. He could not abide", "SECOND OFFICER"), "Sec. Off.");
  assert.equal(bestCue("Ham. No.", "HAMLET"), "Ham.");
  assert.equal(bestCue("First Serv.", "FIRST SERVANT"), "First Serv.");
  assert.equal(bestCue("MRS. PEARCE [returning]", "MRS. PEARCE"), "MRS. PEARCE");
  assert.equal(bestCue("Dr. Rank.", "DOCTOR RANK"), null, "a cue that does not fit the name is not trusted");
  assert.equal(bestCue("Mrs. Hale. Oh, no!", "MRS. HALE"), "Mrs. Hale.");
  const out = assembleSegments(parseRows("1 S SECOND OFFICER | Sec. Off."), ["Sec. Off. He could not abide to see a pig's head gaping."]);
  assert.equal(out[0]!.text, "He could not abide to see a pig's head gaping.");
});

test("skip rows lose overlaps to play content and lowercase wrapped lines rejoin their speech", () => {
  const lines = ["THE FLOWER GIRL. Ought to be ashamed", "", "THE NOTE TAKER Woman: cease this", "instantly; or else seek shelter.", "Page 12"];
  const { segments } = validPrefix(parseRows("1-2 X\n1 S THE FLOWER GIRL | THE FLOWER GIRL.\n3 S THE NOTE TAKER | THE NOTE TAKER\n4 X\n5 X"), lines, 1, 5);
  assert.deepEqual(segments.map((s) => [s.from, s.to, s.type]), [[1, 1, "speech"], [2, 2, "skip"], [3, 4, "speech"], [5, 5, "skip"]]);
});

test("dialogue labelled as not part of the play is reclaimed once the play has started", async () => {
  const { learnCues, reclaimSkips } = await import("./cues.ts");
  const lines = ["Hedda: So you are here again, Judge!", "Brack: As you see.", "Hedda: Not one. I suppose all our set are", "still out of town.", "Brack: And is Tesman not at home?"];
  const rows = parseRows("1 S HEDDA | Hedda:\n2 S BRACK | Brack:\n3-5 X");
  const book = learnCues([...rows, ...parseRows("1 S HEDDA | Hedda:\n1 S HEDDA | Hedda:\n1 S BRACK | Brack:\n1 S BRACK | Brack:")]);
  const out = assembleSegments(reclaimSkips(rows, lines, book, false), lines);
  assert.deepEqual(out.map((l) => [l.speaker, l.text]), [
    ["HEDDA", "So you are here again, Judge!"],
    ["BRACK", "As you see."],
    ["HEDDA", "Not one. I suppose all our set are\nstill out of town."],
    ["BRACK", "And is Tesman not at home?"],
  ]);
  const castList = parseRows("1-2 X");
  assert.deepEqual(reclaimSkips(castList, lines, book, false), castList, "before the play starts nothing is reclaimed");
});

test("parentheses are directions only in scripts that use them that way", async () => {
  const { usesParenDirections } = await import("./pipeline.ts");
  const glaspell = ["HALE. We'll be right out. (Exit Hale.)", "MRS PETERS. (Crossing.) Oh!", "HALE. (Looks.) Well.", "MRS HALE. I see."];
  const rows = parseRows("1 S HALE | HALE. >> (Exit Hale.)\n2 S MRS PETERS | MRS PETERS. >> (Crossing.)\n3 S HALE | HALE. >> (Looks.)\n4 S MRS HALE | MRS HALE.");
  assert.equal(usesParenDirections(rows, glaspell), true);
  assert.deepEqual(splitDirections("We'll be right out, Mr. Hale. (Exit Hale door rear. Sheriff follows", [], true, { closesNext: true }).map((p) => p.direction), [false, true]);
  assert.deepEqual(splitDirections("We'll be right out (I think", [], false).map((p) => p.direction), [false]);
  assert.deepEqual(splitDirections("Trod into the mad. [She sits down on the", [], false, { closesNext: true }).map((p) => p.direction), [false, true]);
  assert.deepEqual(splitDirections("Trod into the mad. [Pok and more words", [], false).map((p) => p.direction), [false], "an OCR bracket with no close nearby stays");
  assert.deepEqual(splitDirections("her way and apologizes]. Beg pardon, miss.", [], false, { openedBefore: true }), [
    { text: "her way and apologizes]", direction: true },
    { text: "Beg pardon, miss.", direction: false },
  ]);
  assert.equal(usesParenDirections(parseRows("1 D\n2 D\n3 D"), ["(Aside)", "(Aloud)", "(Sighs.)"]), true);
  const verse = ["KING. Hath there been such a time (I would fain know that)", "QUEEN. To my sick soul (as sin's true nature is)", "KING. (Which we do tender) Hamlet"];
  assert.equal(usesParenDirections(parseRows("1 S KING | KING.\n2 S QUEEN | QUEEN.\n3 S KING | KING."), verse), false);
});

test("a cue swallowed into a direction with its (Aside) still owns the speech that follows", async () => {
  const { learnCues, repairCues } = await import("./cues.ts");
  const lines = ["LOMOV", "I shall drink some water.", "Drinks.", "CHUBUKOV", "(Aside)", "He's come to borrow money!", "(Aloud)", "What is it, my beauty?"];
  const segs = parseRows("1-2 S LOMOV | LOMOV\n3 D\n4-5 D\n6 C\n7 D\n8 C");
  const book = learnCues([...segs, ...parseRows("1 S LOMOV | LOMOV\n1 S LOMOV | LOMOV\n1 S CHUBUKOV | CHUBUKOV\n1 S CHUBUKOV | CHUBUKOV\n1 S CHUBUKOV | CHUBUKOV")]);
  const joined = joinContinuations([assembleSegments(repairCues(segs, lines, book), lines)]);
  assert.deepEqual(joined.filter((l) => l.kind === "dialogue").map((l) => [l.speaker, l.text]), [
    ["LOMOV", "I shall drink some water."],
    ["CHUBUKOV", "He's come to borrow money!"],
    ["CHUBUKOV", "What is it, my beauty?"],
  ]);
});

test("plain mixed-case cues printed alone on a line are learnt, but only as whole lines", async () => {
  const { learnCues, lineCue } = await import("./cues.ts");
  const lines = ["Bobchinsky", "What an occurrence!", "Bobchinsky", "Yes.", "Bobchinsky", "No.", "Bobchinsky is here, says the servant."];
  const book = learnCues(parseRows("1-2 S BOBCHINSKY | Bobchinsky\n3-4 S BOBCHINSKY | Bobchinsky\n5-6 S BOBCHINSKY | Bobchinsky"), lines);
  assert.equal(lineCue("Bobchinsky", book, ""), "Bobchinsky");
  assert.equal(lineCue("Bobchinsky is here, says the servant.", book, ""), null);
});

test("a heading folded into a scene description is split off", () => {
  const lines = ["Act Second", "The room at the Tesmans'.", "It is afternoon."];
  const out = assembleSegments(parseRows("1-3 D"), lines);
  assert.deepEqual(out.map((l) => [l.kind, l.act, l.text]), [["heading", "2", "Act Second"], ["stage_direction", null, "The room at the Tesmans'.\nIt is afternoon."]]);
});

test("OCR noise and old spellings don't swallow speeches", () => {
  assert.deepEqual(splitDirections("Ah, then you mean to say the contrary direction ] And more.", [], false).map((p) => p.direction), [false]);
  const out = assembleSegments(parseRows("1-2 S EVERY MAN | Euery man."), ["Euery man.", "Alas, I may well wepe."]);
  assert.deepEqual(out.map((l) => [l.speaker, l.text]), [["EVERY MAN", "Alas, I may well wepe."]]);
});

test("a spoken first line reported as the cue is not dropped", () => {
  const out = assembleSegments(parseRows("1-2 S NATALYA | Yes, Miss."), ["Yes, Miss.", "Do sit down."]);
  assert.equal(out[0]!.text, "Yes, Miss.\nDo sit down.");
});

test("a heading without a printed number gets no invented number", () => {
  const out = assembleSegments(parseRows("1 H act=1\n2 H act=1 scene=1\n3 H act=2 scene=1"), ["FIRST ACT", "SCENE", "Scene the First"]);
  assert.deepEqual(out.map((l) => [l.act, l.scene]), [["1", null], [null, null], [null, "1"]]);
});

test("a speech with its cue and a delivery note, labelled as a direction, is turned back into a speech", async () => {
  const { learnCues, lineCue, repairCues } = await import("./cues.ts");
  const lines = ["LORD FANCOURT (aside to JACK). You know, you're placing me in a terribly", "false position.", "LORD FANCOURT takes flowers out of his dress."];
  const book = learnCues(parseRows("1 S LORD FANCOURT BABBERLEY | LORD FANCOURT\n1 S LORD FANCOURT BABBERLEY | LORD FANCOURT\n1 S LORD FANCOURT BABBERLEY | LORD FANCOURT"));
  assert.equal(lineCue(lines[2]!, book, ""), null, "a direction that names the character is not a cue");
  const out = assembleSegments(repairCues(parseRows("1-2 D\n3 D"), lines, book), lines, { parenDirections: true });
  assert.deepEqual(out.map((l) => [l.kind, l.speaker, l.text]), [
    ["stage_direction", null, "(aside to JACK)"],
    ["dialogue", "LORD FANCOURT BABBERLEY", "You know, you're placing me in a terribly\nfalse position."],
    ["stage_direction", null, "LORD FANCOURT takes flowers out of his dress."],
  ]);
});

test("a speech that carries on after a direction closing on the next line keeps its speaker", () => {
  const lines = ['CHARLEY (writing). "Yours sincerely, Charles Wykeham. (Blots and folds', "letter.) Splendid, Jack, you're a genius!"];
  const out = assembleSegments(parseRows("1 S CHARLEY | CHARLEY\n2 D"), lines, { parenDirections: true });
  assert.deepEqual(out.filter((l) => l.kind === "dialogue").map((l) => [l.speaker, l.text]), [
    ["CHARLEY", '"Yours sincerely, Charles Wykeham.'],
    ["CHARLEY", "Splendid, Jack, you're a genius!"],
  ]);
});

test("line breaks and indentation are kept as printed", () => {
  const lines = ["ARIEL", "  Full fathom five thy father lies;", "    Of his bones are coral made;", "  Those are pearls that were his eyes."];
  const out = assembleSegments(parseRows("1-4 S ARIEL | ARIEL"), lines);
  assert.equal(out[0]!.text, "Full fathom five thy father lies;\n  Of his bones are coral made;\nThose are pearls that were his eyes.");
  assert.equal(joinLines(["some-", "thing"]), "something");
});
