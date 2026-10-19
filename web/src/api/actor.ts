import { request, type Auth } from "./client";
import type { ActorLine, FreePart, Invite, LineAudio, LineAudioApi, PracticeResult, RunThrough, Section, SttResult, Take } from "./types";

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

/** All calls scoped to one actor's invite token. */
export function actorApi(token: string) {
  const auth: Auth = { kind: "invite", token };
  return {
    invite: () => request<Invite>("/invite", { auth }),
    start: (firstName: string) => request<void>("/invite/start", { auth, json: { firstName } }),
    /** Free parts to pick up, and picking them up. */
    parts: () => request<{ parts: FreePart[] }>("/invite/parts", { auth }),
    pickUp: (characterIds: string[]) => request<{ characters: { id: string; name: string }[] }>("/invite/parts", { auth, json: { characterIds } }),
    /** Fixes the actor's name (it shows on the call sheet). */
    rename: (name: string) => request<{ actor: { id: string; name: string; firstName: string } }>("/invite/me", { method: "PATCH", auth, json: { name } }),
    /** Deletes one of the actor's own takes; `restoreTake` is its Undo. */
    deleteTake: (takeId: string) => request<{ linesRecorded: number; linesTotal: number }>(`/invite/takes/${takeId}`, { method: "DELETE", auth }),
    restoreTake: (takeId: string) => request<{ linesRecorded: number; linesTotal: number }>(`/invite/takes/${takeId}/restore`, { method: "POST", auth }),
    lines: () => request<{ sections: Section[]; lines: ActorLine[] }>("/invite/lines", { auth }),
    putTake: (lineId: string, audio: Blob, takeId: string, durationMs: number, signal?: AbortSignal, part?: TakePart) =>
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
        },
      }),
    postStt: (takeId: string, result: SttResult) => request<void>(`/invite/takes/${takeId}/stt`, { auth, json: result }),
    contact: (email: string) => request<void>("/invite/contact", { auth, json: { email } }),
    runthrough: () => request<RunThrough>("/invite/runthrough", { auth }),
    /** Line-by-line audio for the run-through player, and for cues that aren't ready yet. */
    lineAudio: {
      line: (lineId, opts = {}) => request<LineAudio>(`/invite/lines/${lineId}/audio${opts.prefetch ? "?prefetch=1" : ""}`, { auth, signal: opts.signal }),
      warm: (lineIds) => request<{ lines: LineAudio[] }>("/invite/lines/audio/warm", { auth, json: { lineIds } }),
    } satisfies LineAudioApi as LineAudioApi,
    practice: (results: PracticeResult[]) =>
      request<{ practice: { id: string; avgAccuracy: number; createdAt: string } }>("/invite/practice", {
        auth,
        json: { mode: "my_part", results },
      }),
  };
}

export type ActorApi = ReturnType<typeof actorApi>;
