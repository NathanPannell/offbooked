import { API_URL, request, type Auth } from "./client";
import type { TakeUploadResult } from "./actor";
import type {
  CastMember,
  Character,
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

const director: Auth = { kind: "director" };
const none: Auth = { kind: "none" };

export const auth = {
  /** Returns a dev sign-in link when the backend logs emails instead of sending them. */
  request: (email: string) =>
    request<{ devLink?: string } | undefined>("/auth/request", { auth: none, json: { email } }),
  verify: (token: string) =>
    request<{ sessionToken: string; user: User }>("/auth/verify", { auth: none, json: { token } }),
  me: () => request<{ user: User }>("/me", { auth: director }),
  updateMe: (name: string) => request<{ user: User }>("/me", { method: "PATCH", auth: director, json: { name } }),
  logout: () => request<void>("/auth/logout", { method: "POST", auth: director }),
};

export const productions = {
  list: () => request<{ productions: Production[] }>("/productions", { auth: director }),
  create: (input: { title: string; performanceDate?: string | null }) =>
    request<{ production: Production }>("/productions", { auth: director, json: input }),
  get: (id: string) => request<{ production: Production }>(`/productions/${id}`, { auth: director }),
  update: (id: string, input: { title?: string; performanceDate?: string | null }) =>
    request<{ production: Production }>(`/productions/${id}`, { method: "PATCH", auth: director, json: input }),
  archive: (id: string) => request<void>(`/productions/${id}/archive`, { method: "POST", auth: director }),
  runthrough: (id: string) => request<RunThrough>(`/productions/${id}/runthrough`, { auth: director }),
  render: (id: string) =>
    request<{ render: Render }>(`/productions/${id}/render`, { method: "POST", auth: director }),
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
  uploadText: (productionId: string, text: string) =>
    request<{ scriptStatus: ScriptStatus }>(`/productions/${productionId}/script`, {
      auth: director,
      json: { text },
    }),
  updateLine: (lineId: string, input: { characterId?: string | null; kind?: LineKind; text?: string }) =>
    request<{ line: Line }>(`/lines/${lineId}`, { method: "PATCH", auth: director, json: input }),
  splitLine: (lineId: string, at: number) =>
    request<{ lines: [Line, Line] }>(`/lines/${lineId}/split`, { auth: director, json: { at } }),
  mergeNext: (lineId: string) =>
    request<{ line: Line }>(`/lines/${lineId}/merge-next`, { method: "POST", auth: director }),
  sectionBreak: (lineId: string, input: { title: string; act?: string; scene?: string }) =>
    request<{ sections: Section[] }>(`/lines/${lineId}/section-break`, { auth: director, json: input }),
  resolveLine: (lineId: string) =>
    request<{ line: Line }>(`/lines/${lineId}/resolve`, { method: "POST", auth: director }),
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

export interface CastInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  characterIds: string[];
}

export const cast = {
  list: (productionId: string) =>
    request<{ cast: CastMember[]; uncastCharacterIds: string[] }>(`/productions/${productionId}/cast`, {
      auth: director,
    }),
  create: (productionId: string, input: CastInput) =>
    request<{ member: CastMember }>(`/productions/${productionId}/cast`, { auth: director, json: input }),
  update: (actorId: string, input: Partial<CastInput>) =>
    request<{ member: CastMember }>(`/cast/${actorId}`, { method: "PATCH", auth: director, json: input }),
  resetLink: (actorId: string) =>
    request<{ member: CastMember }>(`/cast/${actorId}/reset-link`, { method: "POST", auth: director }),
  nudged: (actorId: string) =>
    request<{ member: CastMember }>(`/cast/${actorId}/nudged`, { method: "POST", auth: director }),
};

/** The one link the whole cast can use to pick their characters. */
export const joinLink = {
  get: (productionId: string) => request<{ joinUrl: string }>(`/productions/${productionId}/join-link`, { auth: director }),
  reset: (productionId: string) =>
    request<{ joinUrl: string }>(`/productions/${productionId}/join-link/reset`, { method: "POST", auth: director }),
};

/** Director stand-in recordings, scene by scene. */
export const standins = {
  sectionLines: (productionId: string, sectionId: string) =>
    request<{ section: Section; lines: SectionLine[] }>(`/productions/${productionId}/sections/${sectionId}/lines`, {
      auth: director,
    }),
  putTake: (lineId: string, audio: Blob, takeId: string, durationMs: number, signal?: AbortSignal) =>
    request<TakeUploadResult>(`/lines/${lineId}/take`, {
      method: "PUT",
      auth: director,
      body: audio,
      signal,
      headers: {
        "Content-Type": (audio.type || "application/octet-stream").split(";")[0],
        "X-Take-Id": takeId,
        "X-Duration-Ms": String(Math.round(durationMs)),
      },
    }),
};
