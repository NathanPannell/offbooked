import { readStorage, writeStorage } from "../lib/storage";
import type { MyLineMode } from "./queue";
import { isSpeed, type Speed } from "./timing";

// The listener's run-through settings, remembered per production on this device: which role is
// theirs, what happens on their lines, and how fast everyone else speaks.

/** "" for no role, MY_PART for an actor's own character(s), else a character ID. */
export type Role = string;
export const MY_PART = "mine";

export interface PlayerSettings {
  role: Role;
  mode: MyLineMode;
  speed: Speed;
}

const MODES: MyLineMode[] = ["read", "skip", "pause"];
const key = (productionId: string) => `offbooked.runthrough.${productionId}`;

/**
 * A cast member with a part starts on it, their lines on "Pause, then read" (listening through is
 * practising); anyone else (a listener with no part, the director) just listens, and a part they
 * pick reads out. `?mode=mine` opens "Pause, then read" either way.
 */
export function defaultSettings(isActor: boolean, initialMode: "full" | "mine"): PlayerSettings {
  return { role: isActor ? MY_PART : "", mode: isActor || initialMode === "mine" ? "pause" : "read", speed: 1 };
}

/** Stored settings, checked against what this production and listener allow. */
export function parseSettings(raw: string | null, fallback: PlayerSettings, roles: Set<Role>): PlayerSettings {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as Partial<PlayerSettings>;
    return {
      role: typeof v.role === "string" && (v.role === "" || roles.has(v.role)) ? v.role : fallback.role,
      mode: MODES.includes(v.mode as MyLineMode) ? (v.mode as MyLineMode) : fallback.mode,
      speed: isSpeed(v.speed) ? v.speed : fallback.speed,
    };
  } catch {
    return fallback;
  }
}

export function loadSettings(productionId: string, fallback: PlayerSettings, roles: Set<Role>): PlayerSettings {
  return parseSettings(readStorage(key(productionId)), fallback, roles);
}

export function saveSettings(productionId: string, settings: PlayerSettings): void {
  writeStorage(key(productionId), JSON.stringify(settings));
}

/** The character IDs a role stands for. */
export function roleCharacters(role: Role, myCharacterIds: string[]): Set<string> {
  if (role === MY_PART) return new Set(myCharacterIds);
  return new Set(role ? [role] : []);
}
