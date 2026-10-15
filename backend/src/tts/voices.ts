import { createHash } from "node:crypto";
import { RENDER_SETTINGS } from "../render/plan.ts";

// Synthetic voices for lines nobody has recorded yet. Each character gets one voice for good,
// and characters get different voices while there are voices left.

export interface Voice {
  id: string; // stable name, e.g. "vctk-p225"
  model: string; // Piper model file name without .onnx
  speaker: number | null; // speaker id inside a multi-speaker model
  gender: "f" | "m";
}

export const VOICE_MODELS = ["en_GB-cori-medium", "en_GB-alan-medium", "en_GB-vctk-medium"] as const;

// VCTK speakers with English accents (ids from the model's speaker_id_map).
const VCTK: [string, number, "f" | "m"][] = [
  ["p225", 107, "f"],
  ["p228", 90, "f"],
  ["p229", 85, "f"],
  ["p231", 15, "f"],
  ["p240", 86, "f"],
  ["p250", 3, "f"],
  ["p257", 18, "f"],
  ["p268", 66, "f"],
  ["p226", 95, "m"],
  ["p227", 82, "m"],
  ["p232", 60, "m"],
  ["p243", 81, "m"],
  ["p254", 76, "m"],
  ["p258", 57, "m"],
  ["p259", 4, "m"],
  ["p273", 19, "m"],
];

export const VOICES: Voice[] = [
  { id: "cori", model: "en_GB-cori-medium", speaker: null, gender: "f" },
  { id: "alan", model: "en_GB-alan-medium", speaker: null, gender: "m" },
  ...VCTK.map(([name, speaker, gender]): Voice => ({ id: `vctk-${name}`, model: "en_GB-vctk-medium", speaker, gender })),
];

const FEMALE = new Set(
  (
    "queen lady duchess countess princess empress mother sister daughter wife woman women girl nurse maid maiden mistress widow nun abbess " +
    "witch gentlewoman hostess aunt niece madam mrs miss grandmother bride " +
    "ophelia gertrude juliet rosalind celia viola olivia portia desdemona emilia cordelia goneril regan helena hermia titania hippolyta " +
    "beatrice hero miranda cleopatra isabella katherina katharina kate bianca nora blanche stella laura amanda linda mary anna anne " +
    "elizabeth margaret catherine jane emily sarah alice susan martha ruth irina masha olga sonya nina arkadina"
  ).split(" "),
);
const MALE = new Set(
  (
    "king lord duke earl count baron prince emperor father brother son husband man men boy sir mr friar priest monk bishop cardinal " +
    "captain soldier gentleman uncle nephew grandfather groom"
  ).split(" "),
);

// A guess from words in the character's name ("LADY MACBETH", "FIRST SOLDIER"); null when unsure.
export function guessGender(name: string): "f" | "m" | null {
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => FEMALE.has(w))) return "f";
  if (words.some((w) => MALE.has(w))) return "m";
  return null;
}

function hash32(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

// The narrator reads stage directions in the run-through. No character ever gets this voice, so
// a direction never sounds like someone in the scene. A VCTK speaker, so it shares a loaded model.
export const NARRATOR_VOICE_ID = "vctk-p225";
export const NARRATOR: Voice = VOICES.find((v) => v.id === NARRATOR_VOICE_ID)!;

// Characters must come in creation order (created_at, id), so a character added later never
// changes the voice of one that already exists. Each character starts at a slot picked by a hash
// of its id and moves to the next free voice of a fitting gender. The narrator's voice stays in
// the list (so the hash slots, and with them existing voices, don't move) but is never picked.
export function assignVoices(characters: { id: string; name: string }[], voices: Voice[] = VOICES): Map<string, Voice> {
  const used = new Set<string>();
  const result = new Map<string, Voice>();
  for (const c of characters) {
    const gender = guessGender(c.name);
    const pool = gender ? voices.filter((v) => v.gender === gender) : voices;
    const start = hash32(c.id) % pool.length;
    const ring = Array.from({ length: pool.length }, (_, k) => pool[(start + k) % pool.length]!).filter((v) => v.id !== NARRATOR_VOICE_ID);
    // Every voice taken: reuse, starting from the hash slot.
    const pick = ring.find((v) => !used.has(v.id)) ?? ring[0] ?? voices.find((v) => v.id !== NARRATOR_VOICE_ID)!;
    used.add(pick.id);
    result.set(c.id, pick);
  }
  return result;
}

// Keeps the printed line breaks (each one becomes a pause, see TTS_SETTINGS.lineBreakMs), tidies
// the spaces within each line and drops lines with no words left (a line that is only "—").
const printedLines = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    .join("\n");

// What the voice should say: no bracketed directions, no markup, one printed line per text line.
// Empty when there are no words left.
export function speakable(text: string): string {
  return printedLines(
    text
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\[[^\n]*/g, " ") // an unclosed bracket runs to the end of its line
      .replace(/\{[^}]*\}/g, " ")
      .replace(/[_*]+/g, ""),
  );
}

// What the narrator says for a stage direction: the direction itself, without its brackets or
// markup.
export function speakableDirection(text: string): string {
  return printedLines(text.replace(/[[\]{}()]/g, " ").replace(/[_*]+/g, ""));
}

// A dialogue line as it is read aloud: the character's words, with any [bracketed] direction
// inside it read by the narrator in its place ("Now go. [To the Servant.] Was it not" is three
// parts). An unclosed bracket runs to the end of its printed line. Parts with no words are left out.
export interface SpokenPart {
  narrator: boolean;
  text: string;
}

export function spokenParts(text: string): SpokenPart[] {
  const parts: SpokenPart[] = [];
  const push = (narrator: boolean, raw: string) => {
    const said = narrator ? speakableDirection(raw) : speakable(raw);
    if (!said) return;
    const last = parts[parts.length - 1];
    if (last && last.narrator === narrator) last.text += `\n${said}`;
    else parts.push({ narrator, text: said });
  };
  let at = 0;
  for (let open = text.indexOf("[", at); open !== -1; open = text.indexOf("[", at)) {
    push(false, text.slice(at, open));
    const close = text.indexOf("]", open + 1);
    const lineEnd = text.indexOf("\n", open);
    const end = close !== -1 ? close : lineEnd !== -1 ? lineEnd : text.length;
    push(true, text.slice(open + 1, end));
    at = close !== -1 ? close + 1 : end;
  }
  push(false, text.slice(at));
  return parts;
}

// lengthScale: Piper speaks about 2.8–3 words a second; 1.1 brings it nearer a stage pace (about
// 2.5). lineBreakMs: added at the end of each printed line, on top of the ~0.2 s Piper leaves after
// each utterance (about 0.6 s in all, measured), as well as after punctuation, so
// verse isn't run together.
export const TTS_SETTINGS = { version: 2, lengthScale: 1.1, lineBreakMs: 150 } as const;

// Cache key for a synthesized clip: engine, voice, spoken text and everything that shapes the
// normalized audio. Same inputs, same clip, so re-renders only synthesize changed lines.
export function clipHash(engine: string, voice: Voice, text: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: TTS_SETTINGS.version,
        lengthScale: TTS_SETTINGS.lengthScale,
        lineBreakMs: TTS_SETTINGS.lineBreakMs,
        engine,
        model: voice.model,
        speaker: voice.speaker,
        text,
        sampleRate: RENDER_SETTINGS.sampleRate,
        loudnessI: RENDER_SETTINGS.loudnessI,
      }),
    )
    .digest("hex");
}
