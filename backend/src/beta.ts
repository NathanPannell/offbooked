import { safeEqual, sha256 } from "./crypto.ts";

/** The access code when BETA_ACCESS_CODE isn't set. */
export const DEFAULT_BETA_ACCESS_CODE = "break a leg";

/**
 * What a typed code is compared by: letters and digits only, lowercased, accents dropped, so
 * "Break a leg!", "break-a-leg" and "BREAK  A  LEG" are all the same code.
 */
export function normalizeCode(code: string): string {
  return code
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Compared as hashes, so the comparison takes the same time whatever was typed.
export function codeMatches(given: string, expected: string): boolean {
  const a = normalizeCode(given);
  const b = normalizeCode(expected);
  return !!a && !!b && safeEqual(sha256(a), sha256(b));
}
