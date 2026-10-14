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

// Characters must come in creation order (created_at, id), so a character added later never
// changes the voice of one that already exists. Each character starts at a slot picked by a hash
// of its id and moves to the next free voice of a fitting gender.
export function assignVoices(characters: { id: string; name: string }[], voices: Voice[] = VOICES): Map<string, Voice> {
  const used = new Set<string>();
  const result = new Map<string, Voice>();
  for (const c of characters) {
    const gender = guessGender(c.name);
    const pool = gender ? voices.filter((v) => v.gender === gender) : voices;
    const start = hash32(c.id) % pool.length;
    let pick = pool[start]!;
    for (let k = 0; k < pool.length; k++) {
      const v = pool[(start + k) % pool.length]!;
      if (!used.has(v.id)) {
        pick = v;
        break;
      }
    }
    used.add(pick.id);
    result.set(c.id, pick);
  }
  return result;
}

// What the voice should say: no bracketed directions, no markup, one utterance. Empty when there
// are no words left (a line that is only "—").
export function speakable(text: string): string {
  const cleaned = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/[_*]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
}

export const TTS_SETTINGS = { version: 1 } as const;

// Cache key for a synthesized clip: engine, voice, spoken text and everything that shapes the
// normalized audio. Same inputs, same clip, so re-renders only synthesize changed lines.
export function clipHash(engine: string, voice: Voice, text: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: TTS_SETTINGS.version,
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
