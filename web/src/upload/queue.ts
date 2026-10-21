// Pure state machine for the take upload queue. Persistence and networking live in uploader.ts.

export type UploadStatus = "queued" | "uploading" | "saved" | "failed";
export type TakeKind = "invite" | "director";

export interface UploadItem {
  /** Client UUID, sent as X-Take-Id so a repeated upload returns the same take. */
  takeId: string;
  /**
   * Who uploads it. "invite" (the default, and every take stored before director takes existed) uses the
   * actor's invite token; "director" is a director's take sent with their session.
   */
  kind?: TakeKind;
  /** The invite token, or the production ID for a director's take. Scopes the queue per screen. */
  token: string;
  lineId: string;
  /** A director's take on a shared line: the character it voices. */
  characterId?: string | null;
  mime: string;
  durationMs: number;
  /** When each spoken word starts, in ms of the recording, from the live take (sent as X-Word-Starts). */
  wordStartsMs?: number[] | null;
  createdAt: number;
  status: UploadStatus;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
}

/** Automatic attempts before a take waits for a manual retry. */
export const MAX_AUTO_ATTEMPTS = 6;

export type QueueEvent =
  | { type: "begin" }
  | { type: "succeeded" }
  | { type: "failed"; retryable: boolean; message: string; now: number; jitter?: number }
  | { type: "retry"; now: number }
  | { type: "resume"; now: number }
  | { type: "online"; now: number };

/** 1 s, 2 s, 4 s … capped at 30 s, with ±20% jitter (jitter in -1..1). */
export function backoffMs(attempts: number, jitter = 0): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + 0.2 * jitter));
}

export function transition(item: UploadItem, event: QueueEvent): UploadItem {
  switch (event.type) {
    case "begin":
      return item.status === "queued" ? { ...item, status: "uploading", attempts: item.attempts + 1, error: null } : item;
    case "succeeded":
      return item.status === "uploading" ? { ...item, status: "saved", error: null } : item;
    case "failed": {
      if (item.status !== "uploading") return item;
      if (event.retryable && item.attempts < MAX_AUTO_ATTEMPTS) {
        return {
          ...item,
          status: "queued",
          error: event.message,
          nextAttemptAt: event.now + backoffMs(item.attempts, event.jitter ?? 0),
        };
      }
      return { ...item, status: "failed", error: event.message };
    }
    case "retry":
      return item.status === "failed" ? { ...item, status: "queued", attempts: 0, nextAttemptAt: event.now } : item;
    case "resume":
      // An upload cut off by a reload goes again; X-Take-Id makes that safe.
      return item.status === "uploading" ? { ...item, status: "queued", nextAttemptAt: event.now } : item;
    case "online":
      return item.status === "queued" ? { ...item, nextAttemptAt: Math.min(item.nextAttemptAt, event.now) } : item;
  }
}

/**
 * Adds a new take. Older takes for the same line that haven't started uploading are
 * superseded: uploading them later would make a stale take current.
 */
export function enqueue(items: UploadItem[], item: UploadItem): { items: UploadItem[]; superseded: string[] } {
  const superseded = items
    .filter((i) => i.token === item.token && i.lineId === item.lineId && (i.status === "queued" || i.status === "failed"))
    .map((i) => i.takeId);
  return { items: [...items.filter((i) => !superseded.includes(i.takeId)), item], superseded };
}

/** The next take to upload: one at a time, oldest first, so a line's newest take lands last. */
export function nextDue(items: UploadItem[], now: number): UploadItem | null {
  if (items.some((i) => i.status === "uploading")) return null;
  const due = items.filter((i) => i.status === "queued" && i.nextAttemptAt <= now);
  return due.sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

/** When the queue next needs attention, or null if nothing is waiting. */
export function nextWakeAt(items: UploadItem[]): number | null {
  const waiting = items.filter((i) => i.status === "queued").map((i) => i.nextAttemptAt);
  return waiting.length ? Math.min(...waiting) : null;
}

/** The newest take for a line, which is the one the UI reports on. */
export function latestForLine(items: UploadItem[], token: string, lineId: string): UploadItem | null {
  return items.filter((i) => i.token === token && i.lineId === lineId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
