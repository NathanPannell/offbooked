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
  /** The last failure's ApiError code ("network", "timeout", "storage_unavailable", …), for the status shown. */
  errorCode?: string | null;
}

/** Longest wait between automatic attempts. A take that can still land is never given up on. */
export const MAX_BACKOFF_MS = 60_000;

export type QueueEvent =
  | { type: "begin" }
  | { type: "succeeded" }
  | { type: "failed"; retryable: boolean; message: string; code?: string; now: number; jitter?: number; retryAfterMs?: number | null }
  | { type: "retry"; now: number }
  | { type: "resume"; now: number }
  | { type: "online"; now: number };

/** 1 s, 2 s, 4 s … capped at a minute, with ±20% jitter (jitter in -1..1). */
export function backoffMs(attempts: number, jitter = 0): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + 0.2 * jitter));
}

export function transition(item: UploadItem, event: QueueEvent): UploadItem {
  switch (event.type) {
    case "begin":
      // The last error stays until the attempt ends, so the status doesn't flicker back to "Saving…".
      return item.status === "queued" ? { ...item, status: "uploading", attempts: item.attempts + 1 } : item;
    case "succeeded":
      return item.status === "uploading" ? { ...item, status: "saved", error: null, errorCode: null } : item;
    case "failed": {
      if (item.status !== "uploading") return item;
      const errorCode = event.code ?? null;
      if (event.retryable) {
        // Keeps trying, however long the server or the signal is gone: the take is safe on the device.
        const wait = Math.max(backoffMs(item.attempts, event.jitter ?? 0), event.retryAfterMs ?? 0);
        return { ...item, status: "queued", error: event.message, errorCode, nextAttemptAt: event.now + wait };
      }
      return { ...item, status: "failed", error: event.message, errorCode };
    }
    case "retry":
      if (item.status === "failed") return { ...item, status: "queued", attempts: 0, nextAttemptAt: event.now };
      return item.status === "queued" ? { ...item, nextAttemptAt: Math.min(item.nextAttemptAt, event.now) } : item;
    case "resume":
      // On launch everything left goes at once: an upload cut off by a reload or a crash (X-Take-Id
      // makes that safe), one still waiting out an earlier visit's backoff, and one that failed before,
      // in case what stopped it (a server fault, an old app) is fixed.
      return item.status === "saved" ? item : { ...item, status: "queued", nextAttemptAt: event.now };
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

export type UploadState = "saving" | "offline" | "retrying" | "failed" | "saved";

/**
 * What to tell the person about a take: still going up, waiting for a connection, refused by the
 * server for now (it keeps trying), or failed for good (it needs them).
 */
export function uploadState(item: UploadItem): UploadState {
  if (item.status === "saved" || item.status === "failed") return item.status;
  if (!item.errorCode) return "saving";
  return item.errorCode === "network" || item.errorCode === "timeout" ? "offline" : "retrying";
}

/** The newest take for a line, which is the one the UI reports on. */
export function latestForLine(items: UploadItem[], token: string, lineId: string): UploadItem | null {
  return items.filter((i) => i.token === token && i.lineId === lineId).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}
