import { request, type Auth } from "./client";
import type {
  CastMember,
  Character,
  Line,
  LineKind,
  Production,
  Render,
  RunThrough,
  Script,
  ScriptStatus,
  Section,
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
};

export const script = {
  get: (productionId: string) => request<Script>(`/productions/${productionId}/script`, { auth: director }),
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
