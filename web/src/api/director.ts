import { API_URL, request, type Auth } from "./client";
import { partHeaders, wordStartHeaders, type TakePart, type TakePartResult, type TakeUploadResult } from "./actor";
import type { SplitSecond } from "../routes/director/lineJoin";
import type {
  CallSheetCharacter,
  Character,
  FlagCode,
  Line,
  LineAudio,
  LineAudioApi,
  LineKind,
  Production,
  Render,
  RunThrough,
  Script,
  ScriptSource,
  ScriptStatus,
  Section,
  SectionLine,
  User,
} from "./types";

export interface DeletedLine {
  line: Line;
  /** The line it sat after (null: it was the first line). */
  afterLineId: string | null;
  /** Its scene, when the line was the scene's only line and the scene went with it. */
  removedSection: Section | null;
}

export interface InsertLine {
  afterLineId: string | null;
  sectionId?: string;
  newSection?: { title: string; act?: string | null; scene?: string | null };
  kind: LineKind;
  characterId?: string | null;
  text: string;
  flagged?: boolean;
  flagCode?: FlagCode | null;
  flagReason?: string | null;
  sourceLine?: number | null;
  sourcePage?: number | null;
}

const director: Auth = { kind: "director" };
const none: Auth = { kind: "none" };

export const auth = {
  /** Returns a dev sign-in link when the backend logs emails instead of sending them. */
  request: (email: string, next?: string | null) =>
    request<{ devLink?: string } | undefined>("/auth/request", { auth: none, json: next ? { email, next } : { email } }),
  verify: (token: string) => request<{ sessionToken: string; user: User }>("/auth/verify", { auth: none, json: { token } }),
  me: () => request<{ user: User }>("/me", { auth: director }),
  updateMe: (name: string) => request<{ user: User }>("/me", { method: "PATCH", auth: director, json: { name } }),
  logout: () => request<void>("/auth/logout", { method: "POST", auth: director }),
};

/** YYYY-MM-DD. A new production without a final date gets one a year out; an update can't clear it. */
export interface PerformanceDates {
  performanceStartsOn?: string | null;
  performanceEndsOn?: string;
}

export const productions = {
  list: () => request<{ productions: Production[] }>("/productions", { auth: director }),
  create: (input: { title: string } & PerformanceDates) => request<{ production: Production }>("/productions", { auth: director, json: input }),
  get: (id: string) => request<{ production: Production }>(`/productions/${id}`, { auth: director }),
  update: (id: string, input: { title?: string } & PerformanceDates) =>
    request<{ production: Production }>(`/productions/${id}`, { method: "PATCH", auth: director, json: input }),
  archive: (id: string) => request<void>(`/productions/${id}/archive`, { method: "POST", auth: director }),
  runthrough: (id: string) => request<RunThrough>(`/productions/${id}/runthrough`, { auth: director }),
  render: (id: string) => request<{ render: Render }>(`/productions/${id}/render`, { method: "POST", auth: director }),
  /** Line-by-line audio for the run-through player. */
  lineAudio: (id: string): LineAudioApi => ({
    line: (lineId, opts = {}) =>
      request<LineAudio>(`/productions/${id}/lines/${lineId}/audio${opts.prefetch ? "?prefetch=1" : ""}`, { auth: director, signal: opts.signal }),
    warm: (lineIds) => request<{ lines: LineAudio[] }>(`/productions/${id}/lines/audio/warm`, { auth: director, json: { lineIds } }),
  }),
};

export const script = {
  get: (productionId: string) => request<Script>(`/productions/${productionId}/script`, { auth: director }),
  /** The prepared source text around a source line, for showing where a script line came from. */
  source: (productionId: string, line: number, context = 40, signal?: AbortSignal) =>
    request<ScriptSource>(`/productions/${productionId}/script/source?line=${line}&context=${context}`, {
      auth: director,
      signal,
    }),
  /** The original upload. Needs the director Authorization header (see `directorHeaders`). */
  fileUrl: (productionId: string) => `${API_URL}/api/productions/${productionId}/script/file`,
  uploadFile: (productionId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ scriptStatus: ScriptStatus }>(`/productions/${productionId}/script`, {
      auth: director,
      body: form,
    });
  },
  /** An edit clears the line's flag; undo sends `flagged` (with its code and reason) to put it back. */
  updateLine: (
    lineId: string,
    input: {
      characterId?: string | null;
      kind?: LineKind;
      text?: string;
      flagged?: boolean;
      flagCode?: FlagCode | null;
      flagReason?: string | null;
      /** Several people say it (a group is made from their names); on an ALL line, who is on stage (null: Claude's guess). */
      voiceIds?: string[] | null;
    },
  ) => request<{ line: Line }>(`/lines/${lineId}`, { method: "PATCH", auth: director, json: input }),
  /** `second` restores a line that a join removed (undo); without it the new line copies this one. */
  splitLine: (lineId: string, at: number, second?: SplitSecond) =>
    request<{ lines: [Line, Line] }>(`/lines/${lineId}/split`, { auth: director, json: { at, second } }),
  mergeNext: (lineId: string) => request<{ line: Line }>(`/lines/${lineId}/merge-next`, { method: "POST", auth: director }),
  /** Joins the line into the one before it, which keeps its id, kind and speaker. */
  mergePrevious: (lineId: string) => request<{ line: Line }>(`/lines/${lineId}/merge-previous`, { method: "POST", auth: director }),
  /** Deletes a line without recordings; the answer is what `insertLine` needs to undo it. */
  deleteLine: (lineId: string) => request<DeletedLine>(`/lines/${lineId}`, { method: "DELETE", auth: director }),
  insertLine: (productionId: string, input: InsertLine) => request<{ line: Line }>(`/productions/${productionId}/lines`, { auth: director, json: input }),
  sectionBreak: (lineId: string, input: { title: string; act?: string; scene?: string }) =>
    request<{ sections: Section[] }>(`/lines/${lineId}/section-break`, { auth: director, json: input }),
  resolveLine: (lineId: string) => request<{ line: Line }>(`/lines/${lineId}/resolve`, { method: "POST", auth: director }),
  renameSection: (sectionId: string, title: string) =>
    request<{ section: Section }>(`/sections/${sectionId}`, { method: "PATCH", auth: director, json: { title } }),
  createCharacter: (productionId: string, name: string) =>
    request<{ character: Character }>(`/productions/${productionId}/characters`, {
      auth: director,
      json: { name },
    }),
  renameCharacter: (characterId: string, name: string) =>
    request<{ character: Character }>(`/characters/${characterId}`, {
      method: "PATCH",
      auth: director,
      json: { name },
    }),
  mergeCharacter: (characterId: string, intoId: string) =>
    request<{ characters: Character[] }>(`/characters/${characterId}/merge`, { auth: director, json: { intoId } }),
};

/** The director's cast page: a read-only call sheet. The director records a part in its studio. */
export const cast = {
  callSheet: (productionId: string) =>
    request<{ characters: CallSheetCharacter[]; lines: { total: number; recorded: number } }>(`/productions/${productionId}/call-sheet`, { auth: director }),
};

/** The one link the whole cast can use to pick their characters. */
export const joinLink = {
  get: (productionId: string) => request<{ joinUrl: string }>(`/productions/${productionId}/join-link`, { auth: director }),
  reset: (productionId: string) => request<{ joinUrl: string }>(`/productions/${productionId}/join-link/reset`, { method: "POST", auth: director }),
};

/** The director's own recordings, scene by scene or part by part (the studio). */
export const standins = {
  /** Every line a character says (shared ones too), for their studio: the same items as a scene. */
  characterLines: (productionId: string, characterId: string) =>
    request<{ character: { id: string; name: string }; sections: Section[]; lines: SectionLine[] }>(
      `/productions/${productionId}/characters/${characterId}/lines`,
      { auth: director },
    ),
  sectionLines: (productionId: string, sectionId: string) =>
    request<{ section: Section; lines: SectionLine[] }>(`/productions/${productionId}/sections/${sectionId}/lines`, {
      auth: director,
    }),
  /** Deletes any take in the director's production; `restoreTake` is its Undo. */
  deleteTake: (takeId: string) => request<void>(`/takes/${takeId}`, { method: "DELETE", auth: director }),
  restoreTake: (takeId: string) => request<void>(`/takes/${takeId}/restore`, { method: "POST", auth: director }),
  putTake: (
    lineId: string,
    audio: Blob,
    takeId: string,
    durationMs: number,
    signal?: AbortSignal,
    characterId?: string | null,
    part?: TakePart,
    wordStartsMs?: readonly number[] | null,
  ) =>
    request<TakeUploadResult | TakePartResult>(`/lines/${lineId}/take${characterId ? `?characterId=${characterId}` : ""}`, {
      method: "PUT",
      auth: director,
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
};
