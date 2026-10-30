import { readStorage, writeStorage } from "../lib/storage";
import type { MyLineMode } from "./queue";

// The listener's run-through settings, remembered per production on this device: which role is
// theirs, what happens on their lines, and where they had got to. How fast everyone else speaks is
// the app's one playback speed (audio/speed.ts), not a setting per production.

/** "" for no role, MY_PART for an actor's own character(s), else a character ID. */
export type Role = string;
export const MY_PART = "mine";

/** The picker's choice: what happens on the listener's lines, or "all" for the whole play, nothing left out ("Pause, then read" on their lines). */
export type PlayerMode = MyLineMode | "all";

export interface PlayerSettings {
  role: Role;
  mode: PlayerMode;
  /**
   * The listener picked `mode` themselves. Only then is a stored mode used: a change of part also
   * saves the mode in force, and that one (an old default, say) shouldn't stick.
   */
  modePicked?: boolean;
}

const MODES: PlayerMode[] = ["read", "skip", "pause", "all"];
const key = (productionId: string) => `offbooked.runthrough.${productionId}`;

/**
 * A cast member with a part starts on it, their lines on "Pause, then read" (listening through is
 * practising); anyone else (a listener with no part, the director) just listens, and a part they
 * pick reads out. `?mode=mine` opens "Pause, then read" either way.
 */
export function defaultSettings(isActor: boolean, initialMode: "full" | "mine"): PlayerSettings {
  return { role: isActor ? MY_PART : "", mode: isActor || initialMode === "mine" ? "pause" : "read" };
}

/** The settings after a change; picking a mode marks it as the listener's own choice. */
export function changeSettings(current: PlayerSettings, patch: Partial<PlayerSettings>): PlayerSettings {
  return { ...current, ...patch, ...(patch.mode !== undefined ? { modePicked: true } : {}) };
}

/**
 * Stored settings, checked against what this production and listener allow. A stored mode only
 * counts when the listener picked it (`modePicked`); otherwise the default for them applies.
 */
export function parseSettings(raw: string | null, fallback: PlayerSettings, roles: Set<Role>): PlayerSettings {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as Partial<PlayerSettings>;
    const picked = v.modePicked === true && MODES.includes(v.mode as PlayerMode);
    return {
      role: typeof v.role === "string" && (v.role === "" || roles.has(v.role)) ? v.role : fallback.role,
      mode: picked ? (v.mode as PlayerMode) : fallback.mode,
      ...(picked ? { modePicked: true } : {}),
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

const placeKey = (productionId: string) => `offbooked.runthrough.${productionId}.line`;

/** The line the listener had got to, so a reload or a new visit picks up there. */
export function loadPlace(productionId: string): string | null {
  return readStorage(placeKey(productionId)) || null;
}

/** Remembers the line reached; null once the play has finished, so the next visit starts again. */
export function savePlace(productionId: string, lineId: string | null): void {
  writeStorage(placeKey(productionId), lineId ?? "");
}

/** The character IDs a role stands for. */
export function roleCharacters(role: Role, myCharacterIds: string[]): Set<string> {
  if (role === MY_PART) return new Set(myCharacterIds);
  return new Set(role ? [role] : []);
}
