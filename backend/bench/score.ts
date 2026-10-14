import { diffArrays } from "diff";
import type { StructuredScript } from "../src/parse/types.ts";

export interface Golden {
  title: string;
  characters: { name: string; aliases: string[] }[];
  sections: { act: string | null; scene: string | null }[];
  speeches: { speaker: string; text: string }[];
  stageDirectionCount?: number;
}

export interface Score {
  goldWords: number;
  predWords: number;
  recall: number; // golden dialogue words found in predicted dialogue
  precision: number; // predicted dialogue words that are golden dialogue
  speakerAccuracy: number; // golden words attributed to the right character
  speechAccuracy: number; // golden speeches recalled ≥ 90% with the right speaker
  nameAgreement: number; // matched words whose predicted name is the golden name or alias
  goldSpeeches: number;
  predDialogueLines: number;
  spuriousSpeakers: string[];
  missingSpeakers: string[];
  mergedSpeakers: string[];
  sections: { gold: number; pred: number; match: boolean };
  pass: boolean;
  failures: string[];
}

export const THRESHOLDS = { recall: 0.985, precision: 0.985, speakerAccuracy: 0.985, speechAccuracy: 0.97, nameAgreement: 0.95 };

const tokenize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);

const nameKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export function scoreParse(golden: Golden, pred: StructuredScript): Score & { errors: string[] } {
  const gold: { word: string; speaker: string; speech: number }[] = [];
  golden.speeches.forEach((s, i) => tokenize(s.text).forEach((word) => gold.push({ word, speaker: s.speaker, speech: i })));
  const predDialogue = pred.lines.filter((l) => l.kind === "dialogue");
  const predWords: { word: string; speaker: string; line: number }[] = [];
  predDialogue.forEach((l, i) => tokenize(l.text).forEach((word) => predWords.push({ word, speaker: l.character ?? "(none)", line: i })));

  // Word-level alignment of the two dialogue streams.
  const goldToPred = new Int32Array(gold.length).fill(-1);
  let gi = 0;
  let pi = 0;
  for (const part of diffArrays(gold.map((g) => g.word), predWords.map((p) => p.word))) {
    const n = part.count ?? part.value.length;
    if (part.added) pi += n;
    else if (part.removed) gi += n;
    else for (let k = 0; k < n; k++) goldToPred[gi++] = pi++;
  }

  // Map each predicted speaker to the golden speaker it most often aligns with.
  const pairs = new Map<string, Map<string, number>>();
  let matched = 0;
  gold.forEach((g, i) => {
    const p = goldToPred[i]!;
    if (p < 0) return;
    matched++;
    const ps = predWords[p]!.speaker;
    const m = pairs.get(ps) ?? new Map<string, number>();
    m.set(g.speaker, (m.get(g.speaker) ?? 0) + 1);
    pairs.set(ps, m);
  });
  const mapping = new Map<string, string>();
  const mergedSpeakers: string[] = [];
  for (const [ps, m] of pairs) {
    const ranked = [...m].sort((a, b) => b[1] - a[1]);
    mapping.set(ps, ranked[0]![0]);
    const total = ranked.reduce((n, [, c]) => n + c, 0);
    if (ranked[1] && ranked[1][1] >= 20 && ranked[1][1] / total >= 0.15) mergedSpeakers.push(`${ps} ⊇ ${ranked.slice(0, 3).map(([g]) => g).join("+")}`);
  }

  const aliasesOf = new Map<string, Set<string>>();
  for (const c of golden.characters) aliasesOf.set(c.name, new Set([c.name, ...c.aliases].map(nameKey)));
  let correct = 0;
  let named = 0;
  const speechTotals = golden.speeches.map(() => ({ words: 0, matched: 0, correct: 0 }));
  const predSpeakerOfSpeech = golden.speeches.map(() => new Map<string, number>());
  gold.forEach((g, i) => {
    const st = speechTotals[g.speech]!;
    st.words++;
    const p = goldToPred[i]!;
    if (p < 0) return;
    st.matched++;
    const ps = predWords[p]!.speaker;
    const m = predSpeakerOfSpeech[g.speech]!;
    m.set(ps, (m.get(ps) ?? 0) + 1);
    if (mapping.get(ps) === g.speaker) {
      correct++;
      st.correct++;
      if (aliasesOf.get(g.speaker)?.has(nameKey(ps)) || nameKey(ps) === nameKey(g.speaker)) named++;
    }
  });

  const errors: string[] = [];
  let speechesOk = 0;
  speechTotals.forEach((st, i) => {
    const ok = st.words === 0 || (st.matched / st.words >= 0.9 && st.correct / st.words >= 0.9);
    if (ok) speechesOk++;
    else if (errors.length < 60) {
      const s = golden.speeches[i]!;
      const got = [...predSpeakerOfSpeech[i]!].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(", ") || "missing";
      errors.push(`#${i} ${s.speaker}: "${s.text.slice(0, 70)}" → ${got} (recalled ${st.matched}/${st.words})`);
    }
  });

  const lineMatched = new Map<number, number>();
  for (const p of goldToPred) if (p >= 0) lineMatched.set(predWords[p]!.line, (lineMatched.get(predWords[p]!.line) ?? 0) + 1);
  const lineWords = new Map<number, number>();
  predWords.forEach((p) => lineWords.set(p.line, (lineWords.get(p.line) ?? 0) + 1));
  const extra: string[] = [];
  for (const [line, n] of lineWords) {
    if ((lineMatched.get(line) ?? 0) / n < 0.5 && extra.length < 40) extra.push(`extra: ${predDialogue[line]!.character}: "${predDialogue[line]!.text.slice(0, 90)}" (${n} words)`);
  }
  const predTotals = new Map<string, { words: number; matched: number }>();
  predWords.forEach((p) => {
    const t = predTotals.get(p.speaker) ?? { words: 0, matched: 0 };
    t.words++;
    predTotals.set(p.speaker, t);
  });
  for (const [, p] of goldToPred.entries()) if (p >= 0) predTotals.get(predWords[p]!.speaker)!.matched++;
  const spuriousSpeakers = [...predTotals].filter(([, t]) => t.words >= 20 && t.matched / t.words < 0.5).map(([n, t]) => `${n} (${t.words} words)`);
  const goldSpeakerWords = new Map<string, number>();
  gold.forEach((g) => goldSpeakerWords.set(g.speaker, (goldSpeakerWords.get(g.speaker) ?? 0) + 1));
  const mappedGold = new Set(mapping.values());
  const missingSpeakers = [...goldSpeakerWords].filter(([n, w]) => w >= 20 && !mappedGold.has(n)).map(([n]) => n);

  const sectionKey = (s: { act: string | null; scene: string | null }) => `${s.act ?? ""}.${s.scene ?? ""}`;
  const predSections = pred.sections.filter((s) => s.act || s.scene);
  const sectionsMatch =
    golden.sections.length === predSections.length && golden.sections.every((s, i) => sectionKey(s) === sectionKey(predSections[i]!));

  const precisionMatched = goldToPred.reduce((n, p) => n + (p >= 0 ? 1 : 0), 0);
  const score: Score = {
    goldWords: gold.length,
    predWords: predWords.length,
    recall: ratio(matched, gold.length),
    precision: ratio(precisionMatched, predWords.length),
    speakerAccuracy: ratio(correct, gold.length),
    speechAccuracy: ratio(speechesOk, golden.speeches.length),
    nameAgreement: ratio(named, correct),
    goldSpeeches: golden.speeches.length,
    predDialogueLines: predDialogue.length,
    spuriousSpeakers,
    missingSpeakers,
    mergedSpeakers,
    sections: { gold: golden.sections.length, pred: predSections.length, match: sectionsMatch },
    pass: false,
    failures: [],
  };
  for (const [k, min] of Object.entries(THRESHOLDS)) {
    const v = score[k as keyof typeof THRESHOLDS];
    if (v < min) score.failures.push(`${k} ${pct(v)} < ${pct(min)}`);
  }
  if (spuriousSpeakers.length) score.failures.push(`spurious speakers: ${spuriousSpeakers.join(", ")}`);
  if (missingSpeakers.length) score.failures.push(`missing speakers: ${missingSpeakers.join(", ")}`);
  if (mergedSpeakers.length) score.failures.push(`merged speakers: ${mergedSpeakers.join("; ")}`);
  if (!sectionsMatch) score.failures.push(`sections ${predSections.length} vs golden ${golden.sections.length}`);
  score.pass = score.failures.length === 0;
  return { ...score, errors: [...errors, "", ...extra] };
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
export const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
