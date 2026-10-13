import { canonicalName } from "./heuristic.ts";
import type { ParsedLine, StructuredScript } from "./types.ts";

const letters = (s: string) => s.replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// "HAM" abbreviates "HAMLET"; "LADY M" abbreviates "LADY MACBETH".
export function isAbbreviation(short: string, long: string): boolean {
  const s = letters(short);
  const l = letters(long);
  if (s.length < 2 || s === l) return false;
  if (l.startsWith(s)) return true;
  const sw = s.split(" ");
  const lw = l.split(" ");
  return sw.length === lw.length && sw.every((w, i) => lw[i]!.startsWith(w));
}

export interface CharacterResolution {
  characters: { name: string; aliases: string[] }[];
  nameFor: (line: ParsedLine) => string | null;
  flagFor: (line: ParsedLine, index: number) => string | null;
}

// Merges obvious abbreviations into the full name and records every cue spelling as an alias.
// Doubtful merges are applied but flagged; ambiguous abbreviations are left alone and flagged.
export function resolveCharacters(lines: ParsedLine[]): CharacterResolution {
  const counts = new Map<string, number>();
  for (const l of lines) if (l.kind === "dialogue" && l.speaker) counts.set(canonicalName(l.speaker), (counts.get(canonicalName(l.speaker)) ?? 0) + 1);

  const mergeInto = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  const names = [...counts.keys()];
  for (const name of names) {
    const targets = names.filter((other) => other !== name && isAbbreviation(name, other));
    if (targets.length === 1) mergeInto.set(name, targets[0]!);
    else if (targets.length > 1) ambiguous.set(name, targets);
  }
  const finalName = (name: string): string => {
    let n = name;
    for (let i = 0; i < 5 && mergeInto.has(n); i++) n = mergeInto.get(n)!;
    return n;
  };

  const aliases = new Map<string, Set<string>>();
  const doubtful = new Map<string, string>(); // "cue->name" key to reason, flagged on first use
  const addAlias = (name: string, alias: string) => {
    if (alias === name) return;
    if (!aliases.has(name)) aliases.set(name, new Set());
    aliases.get(name)!.add(alias);
  };
  for (const [abbrev, full] of mergeInto) {
    const target = finalName(full);
    addAlias(target, abbrev);
    if (letters(abbrev).length < 3) doubtful.set(`${abbrev}->${target}`, `Merged ${abbrev} into ${target}; check this is the same character`);
  }
  for (const l of lines) {
    if (l.kind !== "dialogue" || !l.speaker) continue;
    const name = finalName(canonicalName(l.speaker));
    if (!aliases.has(name)) aliases.set(name, new Set());
    if (!l.speakerAsWritten) continue;
    const cue = canonicalName(l.speakerAsWritten);
    if (cue === name) continue;
    addAlias(name, cue);
    if (!isAbbreviation(cue, name) && !mergeInto.has(cue)) {
      doubtful.set(`${cue}->${name}`, `Lines cued ${cue} were assigned to ${name}; check this is right`);
    }
  }

  const flagged = new Set<string>();
  return {
    characters: [...aliases].map(([name, set]) => ({ name, aliases: [...set].sort() })),
    nameFor: (l) => (l.kind === "dialogue" && l.speaker ? finalName(canonicalName(l.speaker)) : null),
    flagFor: (l) => {
      if (l.kind !== "dialogue" || !l.speaker) return null;
      const raw = canonicalName(l.speaker);
      const amb = ambiguous.get(raw);
      if (amb) return `${raw} could be ${amb.join(" or ")}; pick the right character`;
      const cue = l.speakerAsWritten ? canonicalName(l.speakerAsWritten) : raw;
      for (const key of [`${cue}->${finalName(raw)}`, `${raw}->${finalName(raw)}`]) {
        if (doubtful.has(key) && !flagged.has(key)) {
          flagged.add(key);
          return doubtful.get(key)!;
        }
      }
      return null;
    },
  };
}

export function sectionTitle(act: string | null, scene: string | null): string {
  const isNum = (s: string) => /^\d+$/.test(s);
  if (act && scene) return isNum(scene) ? `Act ${act}, Scene ${scene}` : `Act ${act}, ${scene}`;
  if (act) return `Act ${act}`;
  if (scene) return isNum(scene) ? `Scene ${scene}` : scene;
  return "Script";
}

// Turns a flat parse into sections, characters and ordered lines. Dialogue without a speaker
// cannot be recorded, so it becomes a flagged stage direction instead.
export function buildStructure(parsed: ParsedLine[]): StructuredScript {
  const chars = resolveCharacters(parsed);
  const sections: StructuredScript["sections"] = [{ act: null, scene: null, title: "Script" }];
  const lines: StructuredScript["lines"] = [];
  let hasDialogue = false;
  let act: string | null = null;
  let scene: string | null = null;

  parsed.forEach((p, index) => {
    const text = p.text.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (p.kind === "heading" && (p.act || p.scene)) {
      const nextAct = p.act ?? act;
      const nextScene = p.act && !p.scene ? null : (p.scene ?? scene);
      if (nextAct !== act || nextScene !== scene) {
        act = nextAct;
        scene = nextScene;
        const section = { act, scene, title: sectionTitle(act, scene) };
        if (hasDialogue) {
          sections.push(section);
          hasDialogue = false;
        } else {
          sections[sections.length - 1] = section;
        }
      }
    }
    const character = chars.nameFor(p);
    if (p.kind === "dialogue" && !character) {
      lines.push({ section: sections.length - 1, kind: "stage_direction", character: null, text, flagReason: p.flagReason ?? "No speaker found for this line" });
      return;
    }
    if (p.kind === "dialogue") hasDialogue = true;
    lines.push({ section: sections.length - 1, kind: p.kind, character, text, flagReason: p.flagReason ?? chars.flagFor(p, index) });
  });

  const used = new Set(lines.map((l) => l.character).filter(Boolean));
  return { sections, characters: chars.characters.filter((c) => used.has(c.name)), lines };
}

// Invariants the database relies on. A failure here is a bug, not a parse problem.
export function validateStructure(s: StructuredScript): string[] {
  const problems: string[] = [];
  const names = new Set(s.characters.map((c) => c.name));
  if (names.size !== s.characters.length) problems.push("duplicate character names");
  let lastSection = 0;
  s.lines.forEach((l, i) => {
    if (l.section < lastSection || l.section >= s.sections.length) problems.push(`line ${i} is out of section order`);
    lastSection = l.section;
    if (l.kind === "dialogue" && (!l.character || !names.has(l.character))) problems.push(`dialogue line ${i} has no known character`);
    if (l.kind !== "dialogue" && l.character) problems.push(`non-dialogue line ${i} has a character`);
    if (!l.text.trim()) problems.push(`line ${i} is empty`);
  });
  return problems;
}
