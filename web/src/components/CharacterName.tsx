import type { CSSProperties } from "react";
import { characterHue } from "../lib/format";

/** A character's name in their own colour, so speakers are easy to tell apart. */
export function CharacterName({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={`character-name ${className}`} style={{ "--hue": characterHue(name) } as CSSProperties}>
      {name}
    </span>
  );
}
