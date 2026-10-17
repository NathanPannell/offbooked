import type { Character, Line } from "../api/types";
import { joinNames, titleCase } from "./format";

/** Who says a line: a shared line's voices, else its character. */
export const voicesOf = (line: Pick<Line, "voiceIds" | "characterId">): string[] => line.voiceIds ?? (line.characterId ? [line.characterId] : []);

/** Whether any of `ids` says the line. */
export const saysLine = (line: Pick<Line, "voiceIds" | "characterId">, ids: ReadonlySet<string>): boolean =>
  (line.characterId !== null && ids.has(line.characterId)) || (line.voiceIds ?? []).some((id) => ids.has(id));

/**
 * The speaker label for a line and, on an ALL-style line, who says it ("Angelo & Escalus"): a named
 * group ("ANGELO, ESCALUS") already says who.
 */
export function speakerLabel(line: Pick<Line, "voiceIds" | "characterId">, characters: Map<string, Character>): { name: string; voices: string | null } {
  const own = line.characterId ? characters.get(line.characterId) : undefined;
  const name = own?.name ?? "";
  if (!line.voiceIds) return { name, voices: null };
  const voices = joinNames(line.voiceIds.flatMap((id) => (characters.get(id) ? [titleCase(characters.get(id)!.name)] : [])));
  return { name, voices: own?.everyone || !name ? voices : null };
}
