import type { CSSProperties } from "react";
import { characterHue } from "../lib/format";

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]!][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]!][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** A round initials badge in a colour of its own. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span className="avatar" aria-hidden="true" style={{ "--hue": characterHue(name), width: size, height: size, fontSize: size * 0.38 } as CSSProperties}>
      {initials(name)}
    </span>
  );
}
