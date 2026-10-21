import { request, type Auth } from "./client";
import type { ActorLine, EmailState, Invite, LineAudio, LineAudioApi, PartCard, RunThrough, Section, SttResult, Take } from "./types";

export interface TakeUploadResult {
  take: Take;
  linesRecorded: number;
  linesTotal: number;
}

/** A long take goes up in parts; until the last one is in, the server says which are missing. */
export interface TakePartResult {
  partial: true;
  parts: number;
  missing: number[];
}

/** Which part of a long take this request carries. */
export interface TakePart {
  index: number;
  total: number;
}

export const partHeaders = (part?: TakePart): Record<string, string> => (part ? { "X-Take-Parts": String(part.total), "X-Take-Part": String(part.index) } : {});

/** The server keeps at most this many word starts (`MAX_WORD_STARTS`), and a header past a few KB risks a 431. */
export const MAX_WORD_STARTS = 2000;
export const MAX_WORD_STARTS_HEADER = 8000;

/**
 * When each spoken word of the take starts, in ms of the recording (see docs/api.md,
 * `X-Word-Starts`). Left out when there are too many to send safely: a refused header would stop
 * the take ever uploading, and the take matters more than its timing.
 */
export function wordStartHeaders(wordStartsMs?: readonly number[] | null): Record<string, string> {
  if (!wordStartsMs?.length || wordStartsMs.length > MAX_WORD_STARTS) return {};
  const value = wordStartsMs.map((ms) => Math.max(0, Math.round(ms))).join(",");
  return value.length > MAX_WORD_STARTS_HEADER ? {} : { "X-Word-Starts": value };
}

/** All calls scoped to one actor's invite token. */
export function actorApi(token: string) {
  const auth: Auth = { kind: "invite", token };
  return {
    invite: () => request<Invite>("/invite", { auth }),
    start: (firstName: string) => request<void>("/invite/start", { auth, json: { firstName } }),
    /** Every part the actor hasn't picked (others may have), and picking them up. */
    parts: () => request<{ parts: PartCard[] }>("/invite/parts", { auth }),
    pickUp: (characterIds: string[]) => request<{ characters: { id: string; name: string }[] }>("/invite/parts", { auth, json: { characterIds } }),
    /** Fixes the actor's name (it shows on the call sheet). */
    rename: (name: string) => request<{ actor: { id: string; name: string; firstName: string } }>("/invite/me", { method: "PATCH", auth, json: { name } }),
    /** Deletes one of the actor's own takes; `restoreTake` is its Undo. */
    deleteTake: (takeId: string) => request<{ linesRecorded: number; linesTotal: number }>(`/invite/takes/${takeId}`, { method: "DELETE", auth }),
    restoreTake: (takeId: string) => request<{ linesRecorded: number; linesTotal: number }>(`/invite/takes/${takeId}/restore`, { method: "POST", auth }),
    lines: (signal?: AbortSignal) => request<{ sections: Section[]; lines: ActorLine[] }>("/invite/lines", { auth, signal }),
    putTake: (
      lineId: string,
      audio: Blob,
      takeId: string,
      durationMs: number,
      signal?: AbortSignal,
      part?: TakePart,
      wordStartsMs?: readonly number[] | null,
    ) =>
      request<TakeUploadResult | TakePartResult>(`/invite/lines/${lineId}/take`, {
        method: "PUT",
        auth,
        body: audio,
        signal,
        headers: {
          "Content-Type": (audio.type || "application/octet-stream").split(";")[0],
          "X-Take-Id": takeId,
          "X-Duration-Ms": String(Math.round(durationMs)),
          ...partHeaders(part),
          ...wordStartHeaders(wordStartsMs),
        },
      }),
    postStt: (takeId: string, result: SttResult) => request<void>(`/invite/takes/${takeId}/stt`, { auth, json: result }),
    /** Sends a link to verify the address; without one, sends it again to the address waiting. */
    contact: (email?: string) => request<EmailState>("/invite/contact", { auth, json: email ? { email } : {} }),
    runthrough: () => request<RunThrough>("/invite/runthrough", { auth }),
    /** Line-by-line audio for the run-through player, and for cues that aren't ready yet. */
    lineAudio: {
      line: (lineId, opts = {}) => request<LineAudio>(`/invite/lines/${lineId}/audio${opts.prefetch ? "?prefetch=1" : ""}`, { auth, signal: opts.signal }),
      warm: (lineIds) => request<{ lines: LineAudio[] }>("/invite/lines/audio/warm", { auth, json: { lineIds } }),
    } satisfies LineAudioApi as LineAudioApi,
  };
}

export type ActorApi = ReturnType<typeof actorApi>;
