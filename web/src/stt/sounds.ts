// How a word sounds, roughly, so the live tracker can follow the script through mishearings: the
// speech model often writes a word that sounds like the one in the line ("due" for "dew", "thy"
// for "the", "lesson" for "less than"), and the line is known, so a word that sounds like the next
// one in the script is the actor saying it. A small metaphone-style key: consonant sounds in order,
// voiced and unvoiced pairs merged (t/d, p/b, k/g, f/v, s/z), vowels dropped after a leading one.

const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const VOICING: Record<string, string> = { b: "p", d: "t", g: "k", v: "f", z: "s", j: "k", q: "k" };
const VOWEL_KEY = /^[AEIOUY]/;

/** Keys worked out so far: the alignment asks for the same few words many times a pass. */
const keys = new Map<string, string>();
const MAX_KEYS = 5000;

/** A word's sound key, e.g. "thought" → "0T", "dew" → "T", "kind" → "KNT", "lesson" → "LSN", "into" → "INT". */
export function soundKey(word: string): string {
  const known = keys.get(word);
  if (known !== undefined) return known;
  if (keys.size >= MAX_KEYS) keys.clear();
  const key = keyOf(word);
  keys.set(word, key);
  return key;
}

function keyOf(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  const s = w
    .replace(/^(kn|gn|pn|wr|ps)/, (m) => m[1]!)
    .replace(/^x/, "s")
    .replace(/^wh/, "w")
    .replace(/mb$/, "m")
    .replace(/ough/g, "o")
    .replace(/augh/g, "a")
    .replace(/igh/g, "i")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/(t?ch|sh|tio|tia|sio)/g, "X")
    .replace(/th/g, "0")
    .replace(/dg(?=[eiy])/g, "j")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/gh/g, "")
    .replace(/qu/g, "kw")
    .replace(/x/g, "ks");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];
    if (VOWELS.has(c)) {
      // A word's first sound, when it's a vowel, keeps which vowel it is ("and" isn't "into").
      if (i === 0) out += c === "y" && next && VOWELS.has(next) ? "Y" : c.toUpperCase();
      continue;
    }
    // h and w only sound before a vowel; y is a vowel here.
    if ((c === "h" || c === "w") && !(next && VOWELS.has(next))) continue;
    const k = c === "X" || c === "0" ? c : (VOICING[c] ?? c).toUpperCase();
    if (out[out.length - 1] !== k) out += k;
  }
  return out;
}

/** Edit distance between two short strings (insert, delete, substitute). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/**
 * Whether two words sound alike: the same sound key, with a consonant in it ("no" and "know",
 * "dew" and "due"), or keys of three or more sounds one apart ("frailty" and "prayalty"), never
 * across a leading vowel ("and" is not "into"). Single letters ("a", "I", "o") only match by spelling.
 */
export function soundsAlike(expected: string, heard: string): boolean {
  if (expected.length < 2 || heard.length < 2) return false;
  const a = soundKey(expected);
  const b = soundKey(heard);
  if (a === b) return /[^AEIOUY]/.test(a);
  // A leading vowel is the most telling sound such a word has.
  if ((VOWEL_KEY.test(a) || VOWEL_KEY.test(b)) && a[0] !== b[0]) return false;
  return expected.length >= 3 && heard.length >= 3 && Math.min(a.length, b.length) >= 3 && distance(a, b) <= 1;
}

/**
 * Whether one word sounds like two run together ("lesson" for "less than"), more strictly than
 * `soundsAlike`: the pair's sounds, or with one sound dropped (said quickly) as long as each word
 * keeps one; never a sound swapped for another ("king" is not "kin and") or a word gone
 * altogether ("mercy" is not "mercy is", "bound" is not "bound to", "from" is not "from me").
 * Both of the pair have two letters or more.
 */
export function soundsLikeJoined(first: string, second: string, heard: string): boolean {
  if (first.length < 2 || second.length < 2 || heard.length < 4) return false;
  const a = soundKey(first);
  const b = soundKey(second);
  const one = soundKey(heard);
  // Heard as just one of them: the other wasn't said (whichever sound the key would drop).
  if (one === a || one === b) return false;
  const pair = a + b;
  if (pair === one) return /[^AEIOUY]/.test(one);
  if (pair.length < 4 || one.length !== pair.length - 1) return false;
  for (let i = 0; i < pair.length; i++) {
    // The dropped sound can't be the only one its word has.
    if ((i < a.length ? a.length : b.length) < 2) continue;
    if (pair.slice(0, i) + pair.slice(i + 1) === one) return true;
  }
  return false;
}
