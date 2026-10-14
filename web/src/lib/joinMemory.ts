// Remembers which actor this device became through a cast link, so reopening the link goes
// straight back to their recording screen. One entry per join link, in localStorage.

export interface JoinMemory {
  inviteToken: string;
  firstName: string;
  characterNames: string[];
  savedAt: number;
}

/** The parts of Storage we use, so tests can pass a plain object. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "offbooked.join.";

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): JoinMemory | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<JoinMemory> | null;
    if (typeof value?.inviteToken !== "string" || !value.inviteToken) return null;
    return {
      inviteToken: value.inviteToken,
      firstName: typeof value.firstName === "string" ? value.firstName : "",
      characterNames: Array.isArray(value.characterNames) ? value.characterNames.filter((n): n is string => typeof n === "string") : [],
      savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function recallJoin(joinToken: string, storage: StorageLike | null = defaultStorage()): JoinMemory | null {
  try {
    return parse(storage?.getItem(PREFIX + joinToken) ?? null);
  } catch {
    return null;
  }
}

export function rememberJoin(
  joinToken: string,
  memory: Omit<JoinMemory, "savedAt"> & { savedAt?: number },
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(PREFIX + joinToken, JSON.stringify({ ...memory, savedAt: memory.savedAt ?? Date.now() }));
  } catch {
    // Private mode or full storage: the actor can still record this visit.
  }
}

export function forgetJoin(joinToken: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(PREFIX + joinToken);
  } catch {
    // Nothing to forget.
  }
}

/** The cast link that led to this invite on this device, if any, so a dead invite can offer "choose again". */
export function joinTokenForInvite(inviteToken: string, storage: StorageLike | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      if (parse(storage.getItem(key))?.inviteToken === inviteToken) return key.slice(PREFIX.length);
    }
  } catch {
    // Storage blocked.
  }
  return null;
}
