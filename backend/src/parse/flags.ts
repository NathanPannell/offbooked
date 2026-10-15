// Standard flag codes for parsed lines the director should check. The web app shows FLAG_LABELS;
// `detail` (stored as lines.flag_reason) is an optional short note, such as the names involved.
// Migration 006_flag_codes.sql backfills older free-text flags with the same buckets as
// classifyFlagReason below; keep the two in step.

export const FLAG_CODES = ["speaker", "missed_cue", "direction", "text", "heading", "backup"] as const;
export type FlagCode = (typeof FLAG_CODES)[number];

export const FLAG_LABELS: Record<FlagCode, string> = {
  speaker: "Confirm the speaker",
  missed_cue: "Check for a missed speaker",
  direction: "Review stage direction",
  text: "Check the text against the original",
  heading: "Check the scene heading",
  backup: "Check this passage",
};

export interface Flag {
  code: FlagCode;
  detail: string | null;
}

export const flag = (code: FlagCode, detail: string | null = null): Flag => ({ code, detail });

export const isFlagCode = (s: unknown): s is FlagCode => typeof s === "string" && (FLAG_CODES as readonly string[]).includes(s);

// Speech that carries on after a direction, page break or heading without a new cue. The parser's
// guess here has always been right, so these are never flagged.
const CONTINUED = /\b(?:continu\w*|resum\w*|carr(?:y|ies) on|goes on)\b/i;
const STILL_UNCLEAR = /\b(?:unclear|could be|may be|might be|garbl\w*|misattribut\w*)\b/i;

// The bucket a free-text reason belongs to, or null for a continued-speaker note that is dropped.
// Checked in this order; the first match wins.
export function classifyFlagReason(reason: string): FlagCode | null {
  const r = reason.toLowerCase();
  if (/backup parser|heuristic/.test(r)) return "backup";
  if (CONTINUED.test(r) && !STILL_UNCLEAR.test(r)) return null;
  if (/missed|more than one speaker|two speakers|very long speech|inline cue|split at/.test(r)) return "missed_cue";
  if (/\b(?:act|scene)\b.*\b(?:inferred|not printed|number|header|heading)\b|\bheading\b|running.header/.test(r)) return "heading";
  if (/differs|not found|labell?ed by the parser|not part of the play|skipp|page number|stray|artifact|footnote|garbled line|marginal|editorial/.test(r)) return "text";
  if (/no speaker found|direction|parenthetical|delivery/.test(r)) return "direction";
  if (/speaker|\bcue|speaks only once|assigned to|could be|merged|joint|shared|sung|song|inferred/.test(r)) return "speaker";
  return null;
}

// Reads the "?? <code>" note the model writes at the end of a row. Anything that is not a known
// code is classified as free text; failing that, it gets the row type's usual code. Notes about a
// speech carrying on after a direction are dropped.
export function parseFlagNote(note: string, fallback: FlagCode): Flag | null {
  const text = note.trim();
  const m = /^(missed[\s_-]cue|[a-z_]+)(?![a-z_])[\s:;,.—–-]*(.*)$/is.exec(text);
  const token = m?.[1]!.toLowerCase().replace(/[\s-]+/g, "_");
  if (token && isFlagCode(token) && token !== "backup") {
    const detail = m![2]!.trim();
    if (detail && CONTINUED.test(detail) && !STILL_UNCLEAR.test(detail)) return null;
    return flag(token, detail ? detail.slice(0, 120) : null);
  }
  if (!text) return flag(fallback);
  if (CONTINUED.test(text) && !STILL_UNCLEAR.test(text)) return null;
  const code = classifyFlagReason(text);
  return flag(code && code !== "backup" ? code : fallback, null);
}
